import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComponentDispatcher, ComponentTool, ModelClient, StateStore } from "@kampong/engine";
import { createServeRuntime } from "../../src/serve-server.js";
import {
  collectServeJobs,
  startServeRunners,
  type ServeRunnersHandle,
} from "../../src/serve-runner.js";

// KAM-117: a `poll` trigger under `kampong serve`: the op is called, one run starts per new item, and a
// restart over the same state does not start them again.

const spec = (extra = "") => `version: "1.1"
agent:
  id: triage
  name: "Triage"
  role: "Support"
  goal: "Triage."
  trigger:
    type: poll
    every: 5m
    use: kampong/gmail-imap@1.0.0
    op: list_unseen
    with:
      mailbox: INBOX
    items: messages
    id: uid
    dedupe: unique${extra}
  workflow:
    - step: triage
      action: write
      query: "Reply to {{ trigger.subject }}"
`;

function memoryStore(): StateStore {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => m.get(k) as never,
    put: async (k, v) => void m.set(k, v),
    exists: async (k) => m.has(k),
    delete: async (k) => m.delete(k),
    putIfAbsent: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
    list: async () => [],
    close: async () => {},
  };
}

const inbox = (...uids: number[]) => ({
  count: uids.length,
  messages: uids.map((uid) => ({ uid, subject: `Question ${uid}` })),
});

function fakeConnector(result: () => unknown) {
  const calls: { tool: ComponentTool; input: unknown }[] = [];
  const components: ComponentDispatcher = {
    prepare: async (tool) => ({
      requiresApproval: false,
      run: async (input) => {
        calls.push({ tool, input });
        return result();
      },
    }),
  };
  return { components, calls };
}

function recordingModel() {
  const prompts: string[] = [];
  const model: ModelClient = {
    generateText: async (request: unknown) => {
      prompts.push(JSON.stringify(request));
      return "done";
    },
    async generateStructured<T>() {
      return {} as T;
    },
  };
  return { model, prompts };
}

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting");
};

describe("kampong serve: poll trigger", () => {
  let dir: string;
  const handles: ServeRunnersHandle[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-serve-poll-"));
  });
  afterEach(async () => {
    for (const h of handles.splice(0)) await h.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function serve(
    source: string,
    connector: ReturnType<typeof fakeConnector>,
    store: StateStore,
    log: string[] = [],
  ) {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, source);
    const { model, prompts } = recordingModel();
    const runtime = createServeRuntime({ specPath, run: { createModel: () => model } });
    const jobs = collectServeJobs(runtime.spec, runtime.runManager, Date.now, {
      components: connector.components,
    });
    const handle = startServeRunners(jobs, {
      openStore: () => store,
      log: (l) => log.push(l),
      // The first poll runs at once; the next never comes due.
      clock: { now: () => Date.now(), sleep: () => new Promise(() => {}) },
    });
    handles.push(handle);
    return { runtime, jobs, handle, prompts };
  }

  it("collects one poll job, and none without the connector deps", () => {
    const connector = fakeConnector(() => inbox());
    const { runtime, jobs } = serve(spec(), connector, memoryStore());
    expect(jobs.map((j) => j.name)).toEqual(["poll"]);
    expect(jobs[0]!.intervalMs).toBe(5 * 60_000);
    expect(collectServeJobs(runtime.spec, runtime.runManager)).toEqual([]);
  });

  it("calls the op with the trigger's input and starts one run per item, reading trigger.*", async () => {
    const connector = fakeConnector(() => inbox(1, 2));
    const { prompts } = serve(spec(), connector, memoryStore());
    await until(() => prompts.length === 2);
    expect(connector.calls).toHaveLength(1);
    expect(connector.calls[0]!.tool).toMatchObject({
      use: "kampong/gmail-imap@1.0.0",
      op: "list_unseen",
    });
    expect(connector.calls[0]!.input).toEqual({ mailbox: "INBOX" });
    expect(prompts.some((p) => p.includes("Reply to Question 1"))).toBe(true);
    expect(prompts.some((p) => p.includes("Reply to Question 2"))).toBe(true);
  });

  it("a restart over the same state starts only what is new", async () => {
    const store = memoryStore();
    const first = serve(
      spec(),
      fakeConnector(() => inbox(1, 2)),
      store,
    );
    await until(() => first.prompts.length === 2);
    await first.handle.stop();

    const second = serve(
      spec(),
      fakeConnector(() => inbox(1, 2, 3)),
      store,
    );
    await until(() => second.prompts.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(second.prompts).toHaveLength(1);
    expect(second.prompts[0]).toContain("Reply to Question 3");
  });

  it("a connector failure is reported, not swallowed", async () => {
    const log: string[] = [];
    const connector = fakeConnector(() => {
      throw new Error("login refused");
    });
    const { prompts } = serve(spec(), connector, memoryStore(), log);
    await until(() => log.some((l) => l.includes("login refused")));
    expect(log[0]).toContain('job "poll" failed (1/5)');
    expect(prompts).toEqual([]);
  });
});
