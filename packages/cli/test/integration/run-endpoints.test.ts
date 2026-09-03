import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@kampong/engine";
import { createDevServer } from "../../src/server.js";

// SLICES.md V2 KAN-1107 ("in-canvas test-run panel"): the server-side half
// of that affordance -- start a run, poll/stream its state, approve/reject
// a pending approval -- exercised over HTTP the same way the canvas talks
// to it. A fake ModelClient is injected via the test-only `run.createModel`
// seam so this never makes a live network call (AGENTS.md's testing
// approach); packages/engine/test/integration/guardrail.test.ts owns the
// deeper guardrail/HITL behavioral coverage.

const TOOL_APPROVAL_SOURCE = `version: "1.0"
agent:
  id: refund-agent
  name: "Refund Agent"
  role: "Support"
  goal: "Process refunds."
  tools:
    - name: issue_refund
      action: http_request
      method: POST
      url: "https://api.stripe.test/v1/refunds"
      requires_approval: true
      extract: status
  workflow:
    - step: parse_request
      action: extract_entities
      confidence_gate: true
    - step: decide
      type: condition
      if: "parse_request.eligible == true"
      then: "execute_tool(issue_refund)"
      else: "request_human_approval"
`;

const NO_MODEL_SOURCE = `version: "1.0"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  model:
    provider: anthropic
    name: claude-3-5-haiku-latest
    api_key: \${KAMPONG_CLI_TEST_MISSING_KEY}
  workflow:
    - step: greet
      action: say_hello
`;

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

describe("createDevServer run endpoints", () => {
  let dir: string;
  let specPath: string;
  let layoutPath: string;
  let app: FastifyInstance;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-server-run-"));
    specPath = join(dir, "agent.yaml");
    layoutPath = join(dir, "layout.json");
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts a run, pauses for a requires_approval tool, and completes once approved", async () => {
    writeFileSync(specPath, TOOL_APPROVAL_SOURCE);
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: "refunded" }), {
        status: 200,
      })) as unknown as typeof fetch;
    app = createDevServer({ specPath, layoutPath, run: { createModel: fakeModel, fetchImpl } });
    await app.ready();

    const start = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { input: "Refund order #1" },
    });
    expect(start.statusCode).toBe(200);
    const startBody = start.json();
    expect(startBody.success).toBe(true);
    expect(startBody.state.status).toBe("awaiting_approval");
    expect(startBody.state.pendingApproval).toMatchObject({
      kind: "tool",
      toolName: "issue_refund",
    });

    const runId = startBody.id as string;
    const getResponse = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
    expect(getResponse.json().state.status).toBe("awaiting_approval");

    const approve = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/approve`,
      payload: { approved: true },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().state.status).toBe("completed");
    expect(approve.json().state.finalOutput.decide).toBe("refunded");
  });

  it("halts with a rejected status and never calls the tool when approval is rejected", async () => {
    writeFileSync(specPath, TOOL_APPROVAL_SOURCE);
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ status: "refunded" }), { status: 200 });
    }) as unknown as typeof fetch;
    app = createDevServer({ specPath, layoutPath, run: { createModel: fakeModel, fetchImpl } });
    await app.ready();

    const start = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { input: "Refund order #1" },
    });
    const runId = start.json().id as string;

    const reject = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/approve`,
      payload: { approved: false, reason: "Looks fraudulent." },
    });

    expect(reject.json().state.status).toBe("rejected");
    expect(reject.json().state.error).toBe("Looks fraudulent.");
    expect(fetchCalls).toBe(0);
  });

  it("returns 422 without starting a run when the spec on disk is invalid", async () => {
    writeFileSync(specPath, 'version: "1.0"\nagent:\n  id: broken\n');
    app = createDevServer({ specPath, layoutPath, run: { createModel: fakeModel } });
    await app.ready();

    const start = await app.inject({ method: "POST", url: "/api/runs", payload: { input: "x" } });
    expect(start.statusCode).toBe(422);
    expect(start.json().success).toBe(false);
  });

  it("returns a specific 400 naming the missing env var, never a generic failure (KAN-1106)", async () => {
    writeFileSync(specPath, NO_MODEL_SOURCE);
    delete process.env.KAMPONG_CLI_TEST_MISSING_KEY;
    // No `run.createModel` override here -- this exercises the real BYOK
    // resolution path in @kampong/engine, deliberately with the env var unset.
    app = createDevServer({ specPath, layoutPath });
    await app.ready();

    const start = await app.inject({ method: "POST", url: "/api/runs", payload: { input: "hi" } });
    expect(start.statusCode).toBe(400);
    expect(start.json().error).toContain("KAMPONG_CLI_TEST_MISSING_KEY");
  });

  it("returns 404 for an unknown run id", async () => {
    writeFileSync(specPath, TOOL_APPROVAL_SOURCE);
    app = createDevServer({ specPath, layoutPath, run: { createModel: fakeModel } });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/runs/does-not-exist/approve",
      payload: { approved: true },
    });
    expect(response.statusCode).toBe(404);
  });
});
