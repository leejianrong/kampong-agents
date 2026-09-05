import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import type { AgentRun, ModelClient, RunState, RunStatus } from "@kampong/engine";
import { RunManager } from "../../src/run-manager.js";

// Code-review finding (V2 PR #3): RunManager's in-memory `runs` map was
// never evicted after a run reached a terminal state, growing unboundedly
// over a long `kampong dev` session. Terminal runs should be dropped a
// short while after they finish, and RunManager.approve() -- the one place
// server.ts now routes approvals through, instead of bypassing it via
// run.resume() directly -- should keep working right up until eviction.

// KAN-1187: RunManager.start() used to await the run all the way to its
// first pause/terminal state before resolving, which meant POST /api/runs
// itself blocked for that entire duration -- see run-manager.ts's start()
// docstring for the full root-cause writeup. It now returns as soon as the
// run is registered, so tests that want the run's *eventual* state need to
// wait for it explicitly the same way a real SSE-driven client would --
// via the run's own "event" emitter, never a raw timer/poll.
function waitForRunStatus(run: AgentRun, statuses: RunStatus[]): Promise<RunState> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      const state = run.getState();
      if (statuses.includes(state.status)) {
        resolve(state);
        return true;
      }
      return false;
    };
    if (check()) return;
    const onEvent = () => {
      if (check()) run.off("event", onEvent);
    };
    run.on("event", onEvent);
  });
}

const SIMPLE_SPEC: AgentSpec = {
  version: "1.0",
  agent: {
    id: "greeter",
    name: "Greeter",
    role: "Front desk",
    goal: "Greet visitors.",
    workflow: [{ step: "greet", action: "say_hello" }],
  },
};

const APPROVAL_SPEC: AgentSpec = {
  version: "1.0",
  agent: {
    id: "refund-agent",
    name: "Refund Agent",
    role: "Support",
    goal: "Process refunds.",
    tools: [
      {
        name: "issue_refund",
        action: "http_request",
        method: "POST",
        url: "https://api.stripe.test/v1/refunds",
        requires_approval: true,
        extract: "status",
      },
    ],
    workflow: [
      { step: "parse_request", action: "extract_entities", confidence_gate: true },
      {
        step: "decide",
        type: "condition",
        if: "parse_request.eligible == true",
        then: "execute_tool(issue_refund)",
        else: "request_human_approval",
      },
    ],
  },
};

function fakeModel(): ModelClient {
  return {
    async generateText() {
      return "hello";
    },
    async generateStructured<T>() {
      return { result: { eligible: true }, confidence: 0.99 } as T;
    },
  };
}

describe("RunManager eviction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a run reachable up to evictAfterMs after it completes, then drops it", async () => {
    const manager = new RunManager({ createModel: fakeModel, evictAfterMs: 1000 });
    const { id, state } = await manager.start(SIMPLE_SPEC, "hi");
    // start() itself only returns the run's untouched initial state now
    // (KAN-1187) -- wait for it to actually reach completion the same way a
    // real SSE-driven client would, via the run's own "event" emitter.
    expect(state.status).toBe("running");
    await waitForRunStatus(manager.get(id)!, ["completed"]);

    expect(manager.get(id)).toBeDefined();

    vi.advanceTimersByTime(999);
    expect(manager.get(id)).toBeDefined();

    vi.advanceTimersByTime(1);
    expect(manager.get(id)).toBeUndefined();
  });

  it("does not evict a run that is still awaiting approval", async () => {
    const manager = new RunManager({ createModel: fakeModel, evictAfterMs: 1000 });
    const { id, state } = await manager.start(APPROVAL_SPEC, "Refund order #1");
    expect(state.status).toBe("running");
    await waitForRunStatus(manager.get(id)!, ["awaiting_approval"]);

    vi.advanceTimersByTime(10_000);
    expect(manager.get(id)).toBeDefined();
  });

  it("evicts a run evictAfterMs after it reaches a terminal state via approve()", async () => {
    const manager = new RunManager({ createModel: fakeModel, evictAfterMs: 1000 });
    const { id } = await manager.start(APPROVAL_SPEC, "Refund order #1");
    await waitForRunStatus(manager.get(id)!, ["awaiting_approval"]);

    const resolved = await manager.approve(id, false, "Looks fraudulent.");
    expect(resolved?.status).toBe("rejected");
    expect(manager.get(id)).toBeDefined();

    vi.advanceTimersByTime(1000);
    expect(manager.get(id)).toBeUndefined();
  });

  it("approve() on an unknown or already-evicted run id resolves undefined rather than throwing", async () => {
    const manager = new RunManager({ createModel: fakeModel, evictAfterMs: 1000 });
    await expect(manager.approve("does-not-exist", true)).resolves.toBeUndefined();
  });
});

// Polls (never a fixed sleep) until `predicate()` is true, yielding to the
// event loop's macrotask queue between checks so pending microtask chains
// (e.g. the workflow generator's own internal awaits) get to run.
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("RunManager.start() (KAN-1187 regression)", () => {
  // Repro: a spec whose first step's model call takes a while (confirmed
  // against a real Ollama daemon at ~85-95s) left the canvas's Test Run
  // panel showing zero progress for the entire duration -- because
  // RunManager.start() used to `await run.start(input)`, and AgentRun.start()
  // (packages/engine) only resolves at the workflow's first
  // pause/terminal yield, never on the first step_started. POST /api/runs
  // was therefore blocked for that whole duration too, so the canvas
  // couldn't even learn the run's id (and so couldn't open the SSE
  // subscription that would show the step in progress) until the run was
  // already paused or done.
  //
  // This proves start() no longer waits on the model call: it resolves
  // with the run's untouched initial state, and the workflow only reaches
  // completion once we deliberately let the first step's model call finish.
  it("resolves with an untouched 'running' state before the first step's model call finishes", async () => {
    let resolveModelCall: (() => void) | undefined;
    const slowModel: ModelClient = {
      async generateText() {
        await new Promise<void>((resolve) => {
          resolveModelCall = resolve;
        });
        return "hello";
      },
      async generateStructured() {
        throw new Error("not used by SIMPLE_SPEC");
      },
    };
    const manager = new RunManager({ createModel: () => slowModel });

    const { id, state } = await manager.start(SIMPLE_SPEC, "hi");
    // Deterministic regardless of how the background generator advance
    // happens to interleave with this await: run.getState() is read
    // synchronously inside start(), before the workflow generator has had
    // any microtask turn to run past its first step_started yield.
    expect(state).toEqual({ status: "running", trace: [] });

    // The model call is genuinely still in flight -- the run hasn't
    // progressed past it, and won't until we resolve it ourselves below.
    await waitUntil(() => resolveModelCall !== undefined);
    expect(manager.get(id)?.getState()).toEqual({ status: "running", trace: [] });

    resolveModelCall!();
    const finalState = await waitForRunStatus(manager.get(id)!, ["completed"]);
    expect(finalState.status).toBe("completed");
  });
});
