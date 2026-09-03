import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { createAgentRun } from "../../src/run.js";
import { createFixtureFetch } from "../../src/tool-fixtures.js";
import type { ModelClient } from "../../src/model.js";

// SLICES.md V3 integration test plan: "Recording a tool call once and
// replaying it in mock mode produces identical results across multiple
// replay runs (determinism)." (KAN-1111.) Exercises the mock/record layer
// through the real run/workflow path (createAgentRun -> runWorkflow ->
// callHttpTool), not just createFixtureFetch in isolation (see this
// package's unit tests for that).

function fixedModel(): ModelClient {
  return {
    async generateText() {
      return "unused";
    },
    async generateStructured<T>() {
      return { result: { order_id: "42" }, confidence: 0.95 } as T;
    },
  };
}

const SPEC: AgentSpec = {
  version: "1.0",
  agent: {
    id: "refund-agent",
    name: "Refund Agent",
    role: "Support",
    goal: "Look up a charge.",
    tools: [
      {
        name: "check_stripe_charge",
        action: "http_request",
        method: "GET",
        url: "https://api.stripe.test/v1/charges/{parse_request.order_id}",
        extract: "data.status",
      },
    ],
    workflow: [
      { step: "parse_request", action: "extract_entities", confidence_gate: true },
      {
        step: "decide",
        type: "condition",
        if: "parse_request.eligible == true",
        then: "x",
        else: "execute_tool(check_stripe_charge)",
      },
    ],
  },
};

describe("mock/record tool layer through a real run (SLICES.md V3, KAN-1111)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-run-fixtures-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records once, then replays deterministically across multiple separate runs with no further network calls", async () => {
    const liveFetch = vi.fn(
      async () => new Response(JSON.stringify({ data: { status: "succeeded" } }), { status: 200 }),
    ) as unknown as typeof fetch;

    const recordFetch = createFixtureFetch({
      mode: "record",
      fixturesDir: dir,
      fetchImpl: liveFetch,
    });
    const recordingRun = createAgentRun(SPEC, { model: fixedModel(), fetchImpl: recordFetch });
    const recorded = await recordingRun.start("Check charge for order #42");

    expect(recorded.status).toBe("completed");
    expect(recorded.finalOutput?.decide).toBe("succeeded");
    expect(liveFetch).toHaveBeenCalledTimes(1);

    // Two independent replay runs against the same fixture directory --
    // network must never be touched, and results must be identical.
    const replayFetch = createFixtureFetch({ mode: "replay", fixturesDir: dir });
    const run1 = createAgentRun(SPEC, { model: fixedModel(), fetchImpl: replayFetch });
    const run2 = createAgentRun(SPEC, { model: fixedModel(), fetchImpl: replayFetch });

    const result1 = await run1.start("Check charge for order #42");
    const result2 = await run2.start("Check charge for order #42");

    expect(result1.status).toBe("completed");
    expect(result2.status).toBe("completed");
    expect(result1.finalOutput?.decide).toBe("succeeded");
    expect(result2.finalOutput?.decide).toBe("succeeded");
    expect(result1.finalOutput).toEqual(result2.finalOutput);
    // Still only the one live call from the recording step, ever.
    expect(liveFetch).toHaveBeenCalledTimes(1);
  });

  it("replay mode fails the run visibly (never a silent live fallback) when no fixture was ever recorded", async () => {
    const replayFetch = createFixtureFetch({ mode: "replay", fixturesDir: dir });
    const run = createAgentRun(SPEC, { model: fixedModel(), fetchImpl: replayFetch });

    const result = await run.start("Check charge for order #42");

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/No recorded fixture/);
  });
});
