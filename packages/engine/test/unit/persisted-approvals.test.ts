import { describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { AgentRun, createAgentRun, type RunState } from "../../src/run.js";
import { runWorkflow, type EngineDeps, type RunEvent } from "../../src/workflow.js";
import {
  APPROVAL_KEY_PREFIX,
  approvalStateKey,
  listPendingApprovals,
  specHash,
  type PersistedApproval,
} from "../../src/pending-approval.js";
import { SqliteStateStore } from "../../src/sqlite-state-store.js";
import type { ModelClient } from "../../src/model.js";
import type { PutOptions, StateStore } from "../../src/state-store.js";
import { createFakeClock } from "./state-store-contract.js";

// KAN-1854 (ADR-0042): a paused run records where it stopped in the StateStore, and an approval resolved
// by key, from a fresh AgentRun (a stand-in for another process), resumes it exactly once. Deterministic:
// a fake model, a recorded Slack response as the only "network", and an in-memory fake store.

class FakeStore implements StateStore {
  readonly data = new Map<string, { value: string; expiresAt?: number }>();
  closed = 0;
  constructor(private readonly clock: () => number = () => 0) {}
  private live(key: string) {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== undefined && e.expiresAt <= this.clock()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }
  async get<T>(key: string) {
    await Promise.resolve(); // a yield point, so two concurrent callers can interleave
    const e = this.live(key);
    return e === undefined ? undefined : (JSON.parse(e.value) as T);
  }
  async put(key: string, value: unknown, options?: PutOptions) {
    this.data.set(key, {
      value: JSON.stringify(value),
      ...(options?.ttlMs !== undefined && { expiresAt: this.clock() + options.ttlMs }),
    });
  }
  async exists(key: string) {
    return this.live(key) !== undefined;
  }
  async delete(key: string) {
    const had = this.live(key) !== undefined;
    this.data.delete(key);
    return had;
  }
  async putIfAbsent(key: string, value: unknown, options?: PutOptions) {
    if (this.live(key)) return false;
    await this.put(key, value, options);
    return true;
  }
  async list<T>(prefix: string) {
    return [...this.data.keys()]
      .filter((k) => k.startsWith(prefix) && this.live(k))
      .sort()
      .map((key) => ({ key, value: JSON.parse(this.data.get(key)!.value) as T }));
  }
  async close() {
    this.closed++;
  }
}

let modelCalls = 0;
const model: ModelClient = {
  async generateText() {
    modelCalls++;
    return "drafted";
  },
  async generateStructured<T>() {
    modelCalls++;
    return { result: { draft: "hello" }, confidence: 1 } as T;
  },
};

// A recorded Slack chat.postMessage response; counts the posts it served.
function slackFixture() {
  const posts: unknown[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, ts: "1700000000.000100", channel: "C1" }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, posts };
}

const spec = (extra: Partial<AgentSpec["agent"]> = {}, steps?: unknown[]): AgentSpec =>
  ({
    version: "1.0",
    agent: {
      id: "responder",
      name: "Responder",
      role: "On call",
      goal: "Tell the channel.",
      tools: [
        {
          name: "announce",
          action: "slack_post_message",
          token: "${SLACK_TOKEN}",
          channel: "#ops",
          text: "Deploy {draft}",
          requires_approval: true,
        },
      ],
      workflow: steps ?? [
        { step: "draft", action: "write" },
        { step: "announce", type: "tool", tool: "announce" },
        { step: "wrap", action: "summarise" },
      ],
      ...extra,
    },
  }) as unknown as AgentSpec;

const env = { SLACK_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv;

function deps(store: StateStore | undefined, over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    model,
    env,
    ...(store && { state: store }),
    persistApprovals: true,
    ...over,
  };
}

async function runToPause(s: AgentSpec, d: EngineDeps, input = "ticket 7") {
  const run = new AgentRun(s, d);
  const state = await run.start(input);
  return { run, state };
}

describe("persisting a pending approval", () => {
  it("records step index, outputs so far, input, spec hash and a key when a run pauses", async () => {
    modelCalls = 0;
    const store = new FakeStore(() => 5_000);
    const s = spec();
    const { state } = await runToPause(s, deps(store, { now: () => 5_000 }));

    expect(state.status).toBe("awaiting_approval");
    const key = state.pendingApproval!.key!;
    expect(key).toMatch(/[0-9a-f-]{36}/);
    const record = await store.get<PersistedApproval>(approvalStateKey(key));
    expect(record).toMatchObject({
      key,
      stepIndex: 1,
      step: "announce",
      phase: "before",
      kind: "tool",
      toolName: "announce",
      input: "ticket 7",
      specHash: specHash(s),
      agentId: "responder",
      createdAt: 5_000,
    });
    expect(Object.keys(record!.outputs)).toEqual(["draft"]);
    expect(record!.expiresAt - record!.createdAt).toBe(7 * 24 * 3600 * 1000);
  });

  it("does not touch a store when persistence is off (the in-memory path is unchanged)", async () => {
    const store = new FakeStore();
    const slack = slackFixture();
    const run = new AgentRun(spec(), {
      model,
      env,
      state: store,
      fetchImpl: slack.fetchImpl,
    });
    const paused = await run.start("x");
    expect(paused.pendingApproval!.key).toBeUndefined();
    expect(store.data.size).toBe(0);
    const done = await run.resume(true);
    expect(done.status).toBe("completed");
    expect(slack.posts).toHaveLength(1);
    expect(store.data.size).toBe(0);
  });

  it("a persisting run with no store fails visibly at the pause", async () => {
    const { state } = await runToPause(spec(), { model, env, persistApprovals: true });
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/needs a state store/);
  });

  it("opens a store lazily for the write and closes it again", async () => {
    const store = new FakeStore();
    const { state } = await runToPause(spec(), {
      model,
      env,
      persistApprovals: true,
      openState: async () => store,
    });
    expect(state.status).toBe("awaiting_approval");
    expect(store.closed).toBe(1);
    expect(store.data.size).toBe(1);
  });

  it("never stores credential-looking trigger headers", async () => {
    const store = new FakeStore();
    const { state } = await runToPause(
      spec(),
      deps(store, {
        trigger: { headers: { authorization: "Bearer s3cret", "x-kind": "deploy" } },
      }),
    );
    const record = await store.get<PersistedApproval>(
      approvalStateKey(state.pendingApproval!.key!),
    );
    expect(record!.trigger).toEqual({ headers: { "x-kind": "deploy" } });
    expect(JSON.stringify([...store.data.values()])).not.toContain("s3cret");
  });
});

describe("resolving by key from another process", () => {
  it("resumes at the paused step with stored outputs, runs the tool once, then clears the record", async () => {
    modelCalls = 0;
    const store = new FakeStore();
    const slack = slackFixture();
    const first = await runToPause(spec(), deps(store, { fetchImpl: slack.fetchImpl }));
    const key = first.state.pendingApproval!.key!;
    expect(modelCalls).toBe(1);

    // The "restart": a brand-new AgentRun that has never seen the first one.
    const second = new AgentRun(spec(), deps(store, { fetchImpl: slack.fetchImpl }));
    const events: RunEvent[] = [];
    second.on("event", (e: RunEvent) => events.push(e));
    const state = await second.resumeByKey(key, true, "ok");

    expect(state.status).toBe("completed");
    expect(slack.posts).toHaveLength(1);
    // The draft step was not run again: one model call before, one after for "wrap".
    expect(modelCalls).toBe(2);
    expect(state.trace.map((t) => t.step)).toEqual(["draft", "announce", "wrap"]);
    expect(state.finalOutput).toHaveProperty("draft");
    expect(store.data.size).toBe(0);
    expect(events[0]).toMatchObject({ type: "step_completed", step: "draft" });
  });

  it("a rejection by key ends the run as rejected, runs nothing and clears the record", async () => {
    const store = new FakeStore();
    const slack = slackFixture();
    const first = await runToPause(spec(), deps(store, { fetchImpl: slack.fetchImpl }));
    const key = first.state.pendingApproval!.key!;
    const state = await new AgentRun(
      spec(),
      deps(store, { fetchImpl: slack.fetchImpl }),
    ).resumeByKey(key, false, "not now");
    expect(state.status).toBe("rejected");
    expect(state.error).toBe("not now");
    expect(slack.posts).toHaveLength(0);
    expect(store.data.size).toBe(0);
  });

  it("a double approve resumes only once (atomic claim), even when both are in flight together", async () => {
    const store = new FakeStore();
    const slack = slackFixture();
    const first = await runToPause(spec(), deps(store, { fetchImpl: slack.fetchImpl }));
    const key = first.state.pendingApproval!.key!;

    const [a, b] = await Promise.all([
      new AgentRun(spec(), deps(store, { fetchImpl: slack.fetchImpl })).resumeByKey(key, true),
      new AgentRun(spec(), deps(store, { fetchImpl: slack.fetchImpl })).resumeByKey(key, true),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["completed", "failed"]);
    expect([a, b].find((s) => s.status === "failed")!.error).toMatch(/already resolved/);
    expect(slack.posts).toHaveLength(1);
  });

  it("an unknown or already resolved key fails visibly", async () => {
    const store = new FakeStore();
    const state = await new AgentRun(spec(), deps(store)).resumeByKey("nope", true);
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/No pending approval with key "nope"/);
  });

  it("an expired approval is gone: it cannot be resumed and is not listed", async () => {
    const clock = createFakeClock();
    const sqlite = new SqliteStateStore({ path: ":memory:", clock });
    const slack = slackFixture();
    const first = await runToPause(
      spec(),
      deps(sqlite, { fetchImpl: slack.fetchImpl, approvalTtlMs: 60_000, now: clock }),
    );
    const key = first.state.pendingApproval!.key!;
    expect(await listPendingApprovals(sqlite)).toHaveLength(1);
    clock.advance(60_001);
    expect(await listPendingApprovals(sqlite)).toHaveLength(0);
    const state = await new AgentRun(spec(), deps(sqlite)).resumeByKey(key, true);
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/expired/);
    expect(slack.posts).toHaveLength(0);
    await sqlite.close();
  });

  it("fails visibly when the spec changed since the pause, keeps the record, and resumes once restored", async () => {
    const store = new FakeStore();
    const slack = slackFixture();
    const first = await runToPause(spec(), deps(store, { fetchImpl: slack.fetchImpl }));
    const key = first.state.pendingApproval!.key!;

    const changed = spec({ goal: "A different goal." });
    const bad = await new AgentRun(
      changed,
      deps(store, { fetchImpl: slack.fetchImpl }),
    ).resumeByKey(key, true);
    expect(bad.status).toBe("failed");
    expect(bad.error).toMatch(/spec changed since approval/);
    expect(slack.posts).toHaveLength(0);
    expect(store.data.has(approvalStateKey(key))).toBe(true);

    const ok = await new AgentRun(spec(), deps(store, { fetchImpl: slack.fetchImpl })).resumeByKey(
      key,
      true,
    );
    expect(ok.status).toBe("completed");
    expect(slack.posts).toHaveLength(1);
  });

  it("a rejection still clears the record after the spec changed (nothing runs)", async () => {
    const store = new FakeStore();
    const first = await runToPause(spec(), deps(store));
    const key = first.state.pendingApproval!.key!;
    const state = await new AgentRun(spec({ goal: "Other." }), deps(store)).resumeByKey(key, false);
    expect(state.status).toBe("rejected");
    expect(store.data.size).toBe(0);
  });

  it("a resumed run that pauses again persists a fresh record under a new key", async () => {
    const store = new FakeStore();
    const s = spec({}, [
      { step: "draft", action: "write" },
      { step: "gate1", type: "approval", message: "first?" },
      { step: "gate2", type: "approval", message: "second?" },
    ]);
    const first = await runToPause(s, deps(store));
    const key1 = first.state.pendingApproval!.key!;
    const second = await new AgentRun(s, deps(store)).resumeByKey(key1, true);
    expect(second.status).toBe("awaiting_approval");
    expect(second.pendingApproval).toMatchObject({ step: "gate2" });
    const key2 = second.pendingApproval!.key!;
    expect(key2).not.toBe(key1);
    expect((await store.list(APPROVAL_KEY_PREFIX)).map((r) => r.key)).toEqual([
      approvalStateKey(key2),
    ]);
    const third = await new AgentRun(s, deps(store)).resumeByKey(key2, true);
    expect(third.status).toBe("completed");
    expect(third.finalOutput).toMatchObject({
      gate1: { approved: true },
      gate2: { approved: true },
    });
  });

  it("a confidence guardrail pause resumes after the step, without running the model again", async () => {
    modelCalls = 0;
    const lowModel: ModelClient = {
      async generateText() {
        modelCalls++;
        return "t";
      },
      async generateStructured<T>() {
        modelCalls++;
        return { result: { v: 1 }, confidence: 0.2 } as T;
      },
    };
    const s = spec(
      { guardrails: { confidence_threshold: 0.9, fallback_action: "escalate_to_human" } },
      [
        { step: "classify", action: "classify", confidence_gate: true },
        { step: "after", action: "x" },
      ],
    );
    const store = new FakeStore();
    const first = await runToPause(s, deps(store, { model: lowModel }));
    expect(first.state.pendingApproval).toMatchObject({ kind: "guardrail", step: "classify" });
    expect(modelCalls).toBe(1);
    const state = await new AgentRun(s, deps(store, { model: lowModel })).resumeByKey(
      first.state.pendingApproval!.key!,
      true,
    );
    expect(state.status).toBe("completed");
    expect(modelCalls).toBe(2); // only "after" ran
  });

  it("an approval step in a version 1.1 spec keeps its trigger and renders the message again", async () => {
    const store = new FakeStore();
    const s = {
      ...spec({}, [
        { step: "gate", type: "approval", message: "Ship {{ trigger.name }}?" },
        { step: "fin", type: "transform", set: { who: "trigger.name" } },
      ]),
      version: "1.1",
    } as AgentSpec;
    const first = await runToPause(
      s,
      deps(store, { trigger: { body: { name: "v2" } } }),
      '{"name":"v2"}',
    );
    expect(first.state.pendingApproval!.reason).toBe("Ship v2?");
    const state = await new AgentRun(s, deps(store)).resumeByKey(
      first.state.pendingApproval!.key!,
      true,
    );
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({ fin: { who: "v2" } });
  });
});

describe("the in-memory resume of a persisted pause", () => {
  it("clears the record when the same run is resumed in process", async () => {
    const store = new FakeStore();
    const slack = slackFixture();
    const { run } = await runToPause(spec(), deps(store, { fetchImpl: slack.fetchImpl }));
    expect(store.data.size).toBe(1);
    const state = await run.resume(true);
    expect(state.status).toBe("completed");
    expect(store.data.size).toBe(0);
  });

  it("stops visibly if another process resolved the approval first", async () => {
    const store = new FakeStore();
    const slack = slackFixture();
    const { run, state } = await runToPause(spec(), deps(store, { fetchImpl: slack.fetchImpl }));
    const other = await new AgentRun(
      spec(),
      deps(store, { fetchImpl: slack.fetchImpl }),
    ).resumeByKey(state.pendingApproval!.key!, true);
    expect(other.status).toBe("completed");
    const late: RunState = await run.resume(true);
    expect(late.status).toBe("failed");
    expect(late.error).toMatch(/already resolved/);
    expect(slack.posts).toHaveLength(1);
  });
});

describe("createAgentRun wiring", () => {
  it("persists to the injected store and resumes by key with createAgentRun", async () => {
    const store = new FakeStore();
    const slack = slackFixture();
    const options = {
      env,
      model,
      state: store,
      fetchImpl: slack.fetchImpl,
      persistApprovals: true,
    };
    const paused = await createAgentRun(spec(), options).start("hi");
    const done = await createAgentRun(spec(), options).resumeByKey(
      paused.pendingApproval!.key!,
      true,
    );
    expect(done.status).toBe("completed");
  });

  it("runWorkflow accepts a resume request directly", async () => {
    const store = new FakeStore();
    const first = await runToPause(spec(), deps(store));
    const gen = runWorkflow(spec(), deps(store), "", {
      key: first.state.pendingApproval!.key!,
      decision: { approved: false, reason: "no" },
    });
    const events: RunEvent[] = [];
    for (let n = await gen.next(); !n.done; n = await gen.next()) events.push(n.value);
    expect(events.at(-1)).toMatchObject({ type: "rejected", step: "announce", reason: "no" });
  });
});
