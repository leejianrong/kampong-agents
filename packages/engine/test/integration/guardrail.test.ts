import { describe, expect, it, vi } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { createAgentRun } from "../../src/run.js";
import type { ModelClient } from "../../src/model.js";

// SLICES.md V2's headline acceptance test (KAN-1108): a guardrail-triggering
// run pauses and requires explicit approval before continuing; rejecting
// halts the run with a clear status. Runs against a fake ModelClient/fetch
// (recorded/fixture-style stubbing, not the shared mock/record file store --
// that's KAN-1111, V3 scope) so this is fully offline and deterministic,
// per AGENTS.md's testing approach.

function fixedConfidenceModel(confidence: number): ModelClient {
  return {
    async generateText() {
      return "unused in this test";
    },
    async generateStructured<T>() {
      return { result: { eligible: true }, confidence } as T;
    },
  };
}

const GUARDRAIL_SPEC: AgentSpec = {
  version: "1.0",
  agent: {
    id: "refund-agent",
    name: "Refund Agent",
    role: "Customer Support Specialist",
    goal: "Review incoming refund requests and process eligible ones.",
    guardrails: { confidence_threshold: 0.85, fallback_action: "escalate_to_human" },
    workflow: [
      { step: "parse_request", action: "extract_entities", inputs: ["order_id"] },
      {
        step: "evaluate_policy",
        action: "check_knowledge",
        query: "Is this order eligible for refund?",
        confidence_gate: true,
      },
    ],
  },
};

describe("guardrail-triggered human approval (SLICES.md V2)", () => {
  it("pauses on threshold breach and resumes only after explicit approval", async () => {
    const run = createAgentRun(GUARDRAIL_SPEC, { model: fixedConfidenceModel(0.4) });

    const paused = await run.start("Refund request for order #42");

    expect(paused.status).toBe("awaiting_approval");
    expect(paused.pendingApproval).toMatchObject({ step: "evaluate_policy", kind: "guardrail" });
    expect(paused.pendingApproval?.reason).toMatch(/0\.4/);
    expect(paused.pendingApproval?.reason).toMatch(/0\.85/);

    const completed = await run.resume(true);

    expect(completed.status).toBe("completed");
    expect(completed.finalOutput?.evaluate_policy).toEqual({ eligible: true });
    expect(completed.trace.map((t) => t.step)).toEqual(["parse_request", "evaluate_policy"]);
  });

  it("halts the run with a clear rejected status when approval is explicitly rejected", async () => {
    const run = createAgentRun(GUARDRAIL_SPEC, { model: fixedConfidenceModel(0.4) });

    const paused = await run.start("Refund request for order #42");
    expect(paused.status).toBe("awaiting_approval");

    const rejected = await run.resume(false, "Confidence too low to trust automatically.");

    expect(rejected.status).toBe("rejected");
    expect(rejected.error).toBe("Confidence too low to trust automatically.");
    expect(rejected.pendingApproval).toBeUndefined();
  });

  // Regression coverage for KAN-1217: "Rejected-approval trace entry says
  // status:failed while the run's own status says rejected". The trace
  // entry for the step whose rejection ended the run must itself carry
  // status "rejected" -- not "failed", which is reserved for a genuine
  // error (see the model-timeout/workflow "failed" coverage elsewhere) --
  // so a consumer reading the trace array alone (kampong run --json, the
  // canvas trace list) sees the same outcome the top-level status reports.
  it("records the rejected step's trace entry with status 'rejected', not 'failed'", async () => {
    const run = createAgentRun(GUARDRAIL_SPEC, { model: fixedConfidenceModel(0.4) });

    await run.start("Refund request for order #42");
    const rejected = await run.resume(false, "Confidence too low to trust automatically.");

    const rejectedEntry = rejected.trace[rejected.trace.length - 1];
    expect(rejectedEntry).toEqual({
      step: "evaluate_policy",
      status: "rejected",
      error: "Confidence too low to trust automatically.",
    });
  });

  it("does not pause when confidence is at or above the threshold", async () => {
    const run = createAgentRun(GUARDRAIL_SPEC, { model: fixedConfidenceModel(0.9) });

    const result = await run.start("Refund request for order #42");

    expect(result.status).toBe("completed");
  });

  it("rejects calling resume() when there is no pending approval", async () => {
    const run = createAgentRun(GUARDRAIL_SPEC, { model: fixedConfidenceModel(0.9) });
    await run.start("Refund request for order #42");

    await expect(run.resume(true)).rejects.toThrow(/no pending approval/);
  });

  it("regression: rejects a second concurrent resume() call instead of racing it onto the next pause point", async () => {
    const run = createAgentRun(GUARDRAIL_SPEC, { model: fixedConfidenceModel(0.4) });
    await run.start("Refund request for order #42");

    const results = await Promise.allSettled([run.resume(true), run.resume(true)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringMatching(/no pending approval/),
    });
    const fulfilledResult = fulfilled[0] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof run.resume>>
    >;
    expect(fulfilledResult.value.status).toBe("completed");
  });
});

const TOOL_APPROVAL_SPEC: AgentSpec = {
  version: "1.0",
  agent: {
    id: "refund-agent",
    name: "Refund Agent",
    role: "Customer Support Specialist",
    goal: "Review incoming refund requests and process eligible ones.",
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

describe("tool-level requires_approval (SLICES.md V2, KAN-1104)", () => {
  it("pauses before a requires_approval tool runs, and only calls it once approved", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ status: "refunded" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const run = createAgentRun(TOOL_APPROVAL_SPEC, {
      model: fixedConfidenceModel(0.99),
      fetchImpl,
    });

    const paused = await run.start("Refund request for order #42");
    expect(paused.status).toBe("awaiting_approval");
    expect(paused.pendingApproval).toMatchObject({
      step: "decide",
      kind: "tool",
      toolName: "issue_refund",
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const completed = await run.resume(true);

    expect(completed.status).toBe("completed");
    expect(completed.finalOutput?.decide).toBe("refunded");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never calls the tool when the approval is rejected", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ status: "refunded" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const run = createAgentRun(TOOL_APPROVAL_SPEC, {
      model: fixedConfidenceModel(0.99),
      fetchImpl,
    });

    await run.start("Refund request for order #42");
    const rejected = await run.resume(false, "Looks fraudulent.");

    expect(rejected.status).toBe("rejected");
    expect(rejected.error).toBe("Looks fraudulent.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("integration test layer wiring", () => {
  it("runs as part of the integration project", () => {
    expect(true).toBe(true);
  });
});
