import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import type { ModelClient } from "@kampong/engine";
import { RunManager } from "../../src/run-manager.js";

// Code-review finding (V2 PR #3): RunManager's in-memory `runs` map was
// never evicted after a run reached a terminal state, growing unboundedly
// over a long `kampong dev` session. Terminal runs should be dropped a
// short while after they finish, and RunManager.approve() -- the one place
// server.ts now routes approvals through, instead of bypassing it via
// run.resume() directly -- should keep working right up until eviction.

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
    expect(state.status).toBe("completed");

    expect(manager.get(id)).toBeDefined();

    vi.advanceTimersByTime(999);
    expect(manager.get(id)).toBeDefined();

    vi.advanceTimersByTime(1);
    expect(manager.get(id)).toBeUndefined();
  });

  it("does not evict a run that is still awaiting approval", async () => {
    const manager = new RunManager({ createModel: fakeModel, evictAfterMs: 1000 });
    const { id, state } = await manager.start(APPROVAL_SPEC, "Refund order #1");
    expect(state.status).toBe("awaiting_approval");

    vi.advanceTimersByTime(10_000);
    expect(manager.get(id)).toBeDefined();
  });

  it("evicts a run evictAfterMs after it reaches a terminal state via approve()", async () => {
    const manager = new RunManager({ createModel: fakeModel, evictAfterMs: 1000 });
    const { id } = await manager.start(APPROVAL_SPEC, "Refund order #1");

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
