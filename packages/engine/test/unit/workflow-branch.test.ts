import { describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { AgentRun } from "../../src/run.js";
import { runWorkflow, type EngineDeps, type RunEvent } from "../../src/workflow.js";
import { approvalStateKey, type PersistedApproval } from "../../src/pending-approval.js";
import type { ModelClient } from "../../src/model.js";
import type { PutOptions, StateStore } from "../../src/state-store.js";

// KAN-1859 (ADR-0045): the branch and stop steps. Deterministic: a fake fetch that records its calls, a fake
// model, and an in-memory store for the pause records.

let modelCalls = 0;
const model: ModelClient = {
  async generateText() {
    modelCalls++;
    return "drafted";
  },
  async generateStructured<T>() {
    modelCalls++;
    return { result: {}, confidence: 1 } as T;
  },
};

class MemStore implements StateStore {
  readonly data = new Map<string, string>();
  async get<T>(key: string) {
    const v = this.data.get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  async put(key: string, value: unknown, _options?: PutOptions) {
    this.data.set(key, JSON.stringify(value));
  }
  async exists(key: string) {
    return this.data.has(key);
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async putIfAbsent(key: string, value: unknown) {
    if (this.data.has(key)) return false;
    this.data.set(key, JSON.stringify(value));
    return true;
  }
  async list<T>(prefix: string) {
    return [...this.data.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, v]) => ({ key, value: JSON.parse(v) as T }));
  }
  async close() {}
}

function fakeFetch() {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as NonNullable<EngineDeps["fetchImpl"]>;
  return { fetchImpl, calls };
}

const TOOLS = [
  { name: "reply", action: "http_request", method: "POST", url: "https://t.test/reply" },
  { name: "escalate", action: "http_request", method: "POST", url: "https://t.test/escalate" },
  {
    name: "page",
    action: "http_request",
    method: "POST",
    url: "https://t.test/page",
    requires_approval: true,
  },
  { name: "log", action: "http_request", method: "GET", url: "https://t.test/log/{{ row.id }}" },
];

const tool = (step: string, name: string) => ({ step, type: "tool", tool: name });
const spec = (workflow: unknown[], version = "1.1"): AgentSpec =>
  ({
    version,
    agent: { id: "br", name: "Br", role: "R", goal: "G", tools: TOOLS, workflow },
  }) as unknown as AgentSpec;

async function drive(s: AgentSpec, input: unknown, deps: Partial<EngineDeps> = {}) {
  const events: RunEvent[] = [];
  const gen = runWorkflow(s, { model, env: {}, ...deps }, JSON.stringify(input));
  let next = await gen.next(undefined);
  while (!next.done) {
    events.push(next.value);
    next = await gen.next(undefined);
  }
  return events;
}
const last = (events: RunEvent[]) => events.at(-1)!;
type Completed = Extract<RunEvent, { type: "completed" }>;
const completed = (events: RunEvent[]) => {
  const e = last(events);
  expect(e.type, JSON.stringify(e)).toBe("completed");
  return e as Completed;
};
const failedMessage = (events: RunEvent[]) => {
  const e = last(events);
  expect(e.type).toBe("failed");
  return (e as Extract<RunEvent, { type: "failed" }>).error;
};
const started = (events: RunEvent[]) =>
  events.filter((e) => e.type === "step_started").map((e) => (e as { step: string }).step);

const IF = (cond: string, then: unknown[], otherwise?: unknown[]) => ({
  step: "route",
  branch: { if: cond, then, ...(otherwise && { else: otherwise }) },
});

describe("branch: if / else", () => {
  const wf = [
    IF("trigger.confident = true", [tool("answer", "reply")], [tool("hand_off", "escalate")]),
    { step: "after", type: "transform", set: { took: "route.taken" } },
  ];

  it("runs the then arm when the condition holds, and leaves the else arm's outputs absent", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const events = await drive(spec(wf), { confident: true }, { fetchImpl });
    const out = completed(events).output;
    expect(calls).toEqual(["POST https://t.test/reply"]);
    expect(out.route).toEqual({ taken: "then" });
    expect(out).toHaveProperty("answer");
    expect(out).not.toHaveProperty("hand_off");
    expect(out.after).toEqual({ took: "then" });
    expect(started(events)).toEqual(["route", "answer", "after"]);
  });

  it("runs the else arm otherwise", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const out = completed(await drive(spec(wf), { confident: false }, { fetchImpl })).output;
    expect(calls).toEqual(["POST https://t.test/escalate"]);
    expect(out.route).toEqual({ taken: "else" });
    expect(out).toHaveProperty("hand_off");
    expect(out).not.toHaveProperty("answer");
  });

  it("with no else and a false condition does nothing, records taken: none and carries on", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const events = await drive(
      spec([IF("trigger.confident = true", [tool("answer", "reply")]), wf[1]]),
      { confident: false },
      { fetchImpl },
    );
    const out = completed(events).output;
    expect(calls).toEqual([]);
    expect(out.route).toEqual({ taken: "none" });
    expect(out.after).toEqual({ took: "none" });
  });

  it("a condition that is not true or false fails the run at the branch step", async () => {
    const events = await drive(spec([IF("trigger.confident", [tool("a", "reply")])]), {
      confident: "yes",
    });
    expect(last(events)).toMatchObject({ type: "failed", step: "route" });
    expect(failedMessage(events)).toMatch(/route/);
  });

  it("a step before the branch is visible to it and a step after reads an arm's output", async () => {
    const out = completed(
      await drive(
        spec([
          { step: "pre", type: "transform", set: { n: "1" } },
          IF("pre.n = 1", [{ step: "inner", type: "transform", set: { v: "pre.n + 41" } }]),
          { step: "post", type: "transform", set: { v: "inner.v" } },
        ]),
        {},
      ),
    ).output;
    expect(out.post).toEqual({ v: 42 });
  });
});

describe("branch: switch", () => {
  const sw = (cases: Record<string, unknown[]>, def?: unknown[]) => ({
    step: "route",
    branch: { switch: "trigger.kind", cases, ...(def && { default: def }) },
  });
  const wf = sw(
    { bug: [tool("a", "reply")], "1": [tool("b", "escalate")] },
    [tool("c", "log")].map((s) => ({ ...s, tool: "reply", step: "fallback" })),
  );

  it("runs the matching case and records which one", async () => {
    const out = completed(
      await drive(spec([wf]), { kind: "bug" }, { fetchImpl: fakeFetch().fetchImpl }),
    ).output;
    expect(out.route).toEqual({ taken: "bug", value: "bug" });
    expect(out).toHaveProperty("a");
  });

  it("compares a number as text, so 1 selects the case written as 1", async () => {
    const out = completed(
      await drive(spec([wf]), { kind: 1 }, { fetchImpl: fakeFetch().fetchImpl }),
    ).output;
    expect(out.route).toEqual({ taken: "1", value: "1" });
    expect(out).toHaveProperty("b");
  });

  it("falls to default when no case matches, and to nothing without one", async () => {
    const out = completed(
      await drive(spec([wf]), { kind: "other" }, { fetchImpl: fakeFetch().fetchImpl }),
    ).output;
    expect(out.route).toEqual({ taken: "default", value: "other" });
    expect(out).toHaveProperty("fallback");
    const none = completed(
      await drive(spec([sw({ bug: [tool("a", "reply")] })]), { kind: "other" }),
    ).output;
    expect(none.route).toEqual({ taken: "none", value: "other" });
  });

  it("a value that is nothing, a list or an object fails the run, naming the step", async () => {
    for (const body of [{}, { kind: [1] }, { kind: { a: 1 } }]) {
      const events = await drive(spec([wf]), body);
      expect(last(events)).toMatchObject({ type: "failed", step: "route" });
      expect(failedMessage(events)).toMatch(/switch/);
    }
  });

  it("a case named like a prototype key does not match by inheritance", async () => {
    const out = completed(
      await drive(spec([sw({ bug: [tool("a", "reply")] })]), { kind: "constructor" }),
    ).output;
    expect(out.route).toEqual({ taken: "none", value: "constructor" });
  });
});

describe("stop", () => {
  const stopWf = (stop: Record<string, unknown>) => [
    { step: "first", type: "transform", set: { n: "1" } },
    IF("trigger.quit = true", [{ step: "halt", stop }]),
    { step: "never", type: "transform", set: { n: "2" } },
  ];

  it("ends the run as completed, as skipped by default, with the reason recorded and the rest not run", async () => {
    const events = await drive(spec(stopWf({ reason: "nothing to do for {{ trigger.id }}" })), {
      quit: true,
      id: 7,
    });
    const done = completed(events);
    expect(done.skipped).toEqual({ step: "halt", reason: "nothing to do for 7" });
    expect(done.output.halt).toEqual({
      stopped: true,
      status: "skipped",
      reason: "nothing to do for 7",
    });
    expect(done.output).not.toHaveProperty("never");
    expect(started(events)).not.toContain("never");
  });

  it("status completed records the reason in the step's output and sets no skipped", async () => {
    const done = completed(
      await drive(spec(stopWf({ reason: "done early", status: "completed" })), { quit: true }),
    );
    expect(done.skipped).toBeUndefined();
    expect(done.output.halt).toEqual({ stopped: true, status: "completed", reason: "done early" });
  });

  it("a stop with no reason says which step stopped", async () => {
    const done = completed(await drive(spec(stopWf({})), { quit: true }));
    expect(done.skipped).toEqual({ step: "halt", reason: 'stopped at step "halt"' });
  });

  it("a branch that does not reach the stop lets the run finish", async () => {
    const done = completed(await drive(spec(stopWf({ reason: "x" })), { quit: false }));
    expect(done.skipped).toBeUndefined();
    expect(done.output).toHaveProperty("never");
  });

  it("a top-level stop ends the run", async () => {
    const done = completed(
      await drive(
        spec([
          { step: "halt", stop: { reason: "r" } },
          { step: "never", type: "transform", set: { n: "1" } },
        ]),
        {},
      ),
    );
    expect(done.skipped).toEqual({ step: "halt", reason: "r" });
  });
});

describe("branch: nesting", () => {
  it("a branch inside an arm", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const wf = [
      IF("trigger.a = true", [
        {
          step: "inner",
          branch: {
            switch: "trigger.k",
            cases: { x: [tool("deep_x", "reply")] },
            default: [tool("deep_d", "escalate")],
          },
        },
      ]),
    ];
    completed(await drive(spec(wf), { a: true, k: "x" }, { fetchImpl }));
    completed(await drive(spec(wf), { a: true, k: "y" }, { fetchImpl }));
    expect(calls).toEqual(["POST https://t.test/reply", "POST https://t.test/escalate"]);
  });

  it("a foreach inside an arm runs per item, and a branch inside a foreach body picks per item", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const wf = [
      IF("$count(trigger.rows) > 0", [
        {
          step: "each",
          foreach: {
            items: "trigger.rows",
            as: "row",
            steps: [
              {
                step: "check",
                branch: {
                  if: "row.ignore = true",
                  then: [{ step: "skip_row", stop: { reason: "row {{ row.id }} ignored" } }],
                  else: [tool("fetch", "log")],
                },
              },
            ],
          },
        },
      ]),
      { step: "count", type: "transform", set: { n: "$count(each.results)" } },
    ];
    const rows = [
      { id: "a", ignore: false },
      { id: "b", ignore: true },
      { id: "c", ignore: false },
    ];
    const events = await drive(spec(wf), { rows }, { fetchImpl });
    const out = completed(events).output as Record<
      string,
      Record<string, unknown> & {
        results: Record<string, unknown>[];
        skipped: unknown[];
        errors: unknown[];
        count: number;
      }
    >;
    // The stop ended only item b: the others ran, and the run itself carries on to the end.
    expect(calls).toEqual(["GET https://t.test/log/a", "GET https://t.test/log/c"]);
    expect(out.each.count).toBe(3);
    expect(out.each.results).toHaveLength(2);
    expect(out.each.skipped).toEqual([
      { index: 1, item: rows[1], step: "skip_row", reason: "row b ignored" },
    ]);
    expect(out.count).toEqual({ n: 2 });
    expect(completed(events).skipped).toBeUndefined();
    expect(started(events)).toContain("each[1].skip_row");
  });

  it("a stop with status completed inside a loop body keeps the item in results", async () => {
    const wf = [
      {
        step: "each",
        foreach: {
          items: "trigger.rows",
          as: "row",
          steps: [
            { step: "halt", stop: { status: "completed", reason: "enough" } },
            { step: "never", type: "transform", set: { n: "1" } },
          ],
        },
      },
    ];
    const out = completed(await drive(spec(wf), { rows: [1, 2] })).output as Record<
      string,
      Record<string, unknown> & {
        results: Record<string, unknown>[];
        skipped: unknown[];
        errors: unknown[];
        count: number;
      }
    >;
    expect(out.each.results).toHaveLength(2);
    expect(out.each.results[0]).toHaveProperty("halt");
    expect(out.each.results[0]).not.toHaveProperty("never");
    expect(out.each.skipped).toEqual([]);
  });

  it("a failing step in an arm of a loop body fails the item under on_error: continue", async () => {
    const wf = [
      {
        step: "each",
        foreach: {
          items: "trigger.rows",
          as: "row",
          on_error: "continue",
          steps: [
            {
              step: "check",
              branch: {
                if: "true",
                then: [{ step: "boom", type: "transform", set: { x: "row.missing.deeper" } }],
              },
            },
          ],
        },
      },
    ];
    const out = completed(await drive(spec(wf), { rows: [1] })).output as Record<
      string,
      Record<string, unknown> & {
        results: Record<string, unknown>[];
        skipped: unknown[];
        errors: unknown[];
        count: number;
      }
    >;
    expect(out.each.errors).toHaveLength(1);
    expect(out.each.errors[0]).toMatchObject({ step: "boom" });
  });
});

describe("branch: unvalidated specs", () => {
  it("a branch or a stop in a version 1.0 spec fails visibly", async () => {
    expect(failedMessage(await drive(spec([IF("true", [tool("a", "reply")])], "1.0"), {}))).toMatch(
      /branch needs version "1.1"/,
    );
    expect(failedMessage(await drive(spec([{ step: "halt", stop: {} }], "1.0"), {}))).toMatch(
      /stop needs version "1.1"/,
    );
  });
});

describe("branch: approvals inside an arm (persisted, KAN-1854)", () => {
  // step 0 draft (model), step 1 route (switch), arm "case:urgent": [prepare (model), approve page, wrap],
  // step 2 done. The pause path of `page` is [1, "case:urgent", 1].
  const wf = [
    { step: "draft", action: "write" },
    {
      step: "route",
      branch: {
        switch: "trigger.kind",
        cases: {
          urgent: [
            { step: "prepare", action: "prepare" },
            tool("page", "page"),
            { step: "wrap", type: "transform", set: { done: "true" } },
          ],
        },
        default: [
          {
            step: "inner",
            branch: {
              if: "true",
              then: [{ step: "ask", type: "approval", message: "ok?" }, tool("after_ask", "reply")],
            },
          },
        ],
      },
    },
    { step: "done", type: "transform", set: { routed: "route.taken" } },
  ];
  const deps = (store: MemStore, fetchImpl: EngineDeps["fetchImpl"]): EngineDeps => ({
    model,
    env: {},
    state: store,
    persistApprovals: true,
    fetchImpl,
  });
  const trigger = { body: { kind: "urgent" } };

  it("records the path, and a fresh run resumes into the nested step, runs it once, and carries on after the arm", async () => {
    modelCalls = 0;
    const store = new MemStore();
    const { fetchImpl, calls } = fakeFetch();
    const first = new AgentRun(spec(wf), { ...deps(store, fetchImpl), trigger });
    const paused = await first.start(JSON.stringify(trigger.body));
    expect(paused.status).toBe("awaiting_approval");
    expect(paused.pendingApproval).toMatchObject({ step: "page", kind: "tool" });
    const key = paused.pendingApproval!.key!;
    const record = (await store.get<PersistedApproval>(approvalStateKey(key)))!;
    expect(record.stepIndex).toBe(1);
    expect(record.stepPath).toEqual([1, "case:urgent", 1]);
    expect(Object.keys(record.outputs)).toEqual(["draft", "route", "prepare"]);
    expect(modelCalls).toBe(2);
    expect(calls).toEqual([]);

    // A restart: a brand-new run that has never seen the first.
    const second = new AgentRun(spec(wf), { ...deps(store, fetchImpl), trigger });
    const events: RunEvent[] = [];
    second.on("event", (e: RunEvent) => events.push(e));
    const state = await second.resumeByKey(key, true, "go");
    expect(state.status).toBe("completed");
    expect(calls).toEqual(["POST https://t.test/page"]);
    // draft and prepare were not run again; the steps after the page in the arm and after the branch were.
    expect(modelCalls).toBe(2);
    expect(state.trace.map((t) => t.step)).toEqual([
      "draft",
      "route",
      "prepare",
      "page",
      "wrap",
      "done",
    ]);
    expect(state.finalOutput).toMatchObject({ done: { routed: "urgent" }, wrap: { done: true } });
    expect(store.data.size).toBe(0);
  });

  it("a rejection by key from inside the arm ends the run as rejected and runs nothing more", async () => {
    const store = new MemStore();
    const { fetchImpl, calls } = fakeFetch();
    const first = await new AgentRun(spec(wf), { ...deps(store, fetchImpl), trigger }).start(
      JSON.stringify(trigger.body),
    );
    const state = await new AgentRun(spec(wf), deps(store, fetchImpl)).resumeByKey(
      first.pendingApproval!.key!,
      false,
      "no",
    );
    expect(state.status).toBe("rejected");
    expect(calls).toEqual([]);
  });

  it("resumes into a branch nested in a branch, through an approval step", async () => {
    const store = new MemStore();
    const { fetchImpl, calls } = fakeFetch();
    const body = { kind: "other" };
    const d = { ...deps(store, fetchImpl), trigger: { body } };
    const first = await new AgentRun(spec(wf), d).start(JSON.stringify(body));
    expect(first.pendingApproval).toMatchObject({ step: "ask", kind: "approval" });
    const key = first.pendingApproval!.key!;
    expect((await store.get<PersistedApproval>(approvalStateKey(key)))!.stepPath).toEqual([
      1,
      "default",
      0,
      "then",
      0,
    ]);
    const state = await new AgentRun(spec(wf), d).resumeByKey(key, true, "fine");
    expect(state.status).toBe("completed");
    expect(calls).toEqual(["POST https://t.test/reply"]);
    expect(state.finalOutput).toMatchObject({
      ask: { approved: true },
      after_ask: expect.anything(),
      done: { routed: "default" },
    });
  });

  it("a second approve of the same key does not run the arm twice", async () => {
    const store = new MemStore();
    const { fetchImpl, calls } = fakeFetch();
    const first = await new AgentRun(spec(wf), { ...deps(store, fetchImpl), trigger }).start(
      JSON.stringify(trigger.body),
    );
    const key = first.pendingApproval!.key!;
    await new AgentRun(spec(wf), deps(store, fetchImpl)).resumeByKey(key, true);
    const again = await new AgentRun(spec(wf), deps(store, fetchImpl)).resumeByKey(key, true);
    expect(again.status).toBe("failed");
    expect(calls).toHaveLength(1);
  });

  it("a record written before branches existed (no stepPath) still resumes at its stepIndex", async () => {
    const store = new MemStore();
    const { fetchImpl, calls } = fakeFetch();
    const flat = spec([{ step: "draft", action: "write" }, tool("page", "page")]);
    const first = await new AgentRun(flat, { ...deps(store, fetchImpl) }).start("x");
    const key = first.pendingApproval!.key!;
    const record = (await store.get<PersistedApproval>(approvalStateKey(key)))!;
    expect(record.stepPath).toEqual([1]);
    delete record.stepPath;
    await store.put(approvalStateKey(key), record);
    const state = await new AgentRun(flat, deps(store, fetchImpl)).resumeByKey(key, true);
    expect(state.status).toBe("completed");
    expect(calls).toEqual(["POST https://t.test/page"]);
  });

  it("without persistence, an in-memory pause inside an arm resumes in place", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const run = new AgentRun(spec(wf), { model, env: {}, fetchImpl, trigger });
    const paused = await run.start(JSON.stringify(trigger.body));
    expect(paused.status).toBe("awaiting_approval");
    const state = await run.resume(true, "ok");
    expect(state.status).toBe("completed");
    expect(calls).toEqual(["POST https://t.test/page"]);
  });
});
