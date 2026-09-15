import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@kampong/engine";
import { createServeServer, ServeSpecInvalidError } from "../../src/serve-server.js";

// KAN-1431 (ADR-0021/ADR-0022): `kampong serve` runs a spec as a live webhook
// service -- POST /webhook starts a run. Driven with a fake ModelClient + a
// canned fetch so it's deterministic and offline, same pattern as the dev
// server's run-endpoints test.

const WEBHOOK_SPEC = `version: "1.0"
agent:
  id: triage
  name: "Triage"
  role: "Support"
  goal: "Triage a message."
  trigger:
    type: webhook
  tools:
    - name: send_reply
      action: http_request
      method: POST
      url: "https://api.helpdesk.test/reply"
      extract: status
  workflow:
    - step: classify
      action: extract_entities
      confidence_gate: true
    - step: lookup
      type: tool
      tool: send_reply
    - step: review
      type: approval
      message: "Approve reply for {{ classify.category }}?"
`;

const INVALID_SPEC = `version: "1.0"
agent:
  id: broken
`;

const BAD_TRIGGER_SPEC = `version: "1.0"
agent:
  id: sched
  name: "Sched"
  role: "x"
  goal: "y"
  trigger:
    type: schedule
  workflow:
    - step: go
      action: do
`;

function fakeModel(): ModelClient {
  return {
    async generateText() {
      return "drafted";
    },
    async generateStructured<T>() {
      return { result: { category: "refund" }, confidence: 0.99 } as T;
    },
  };
}

const okFetch = (async () =>
  new Response(JSON.stringify({ status: "sent" }), { status: 200 })) as unknown as typeof fetch;

async function waitForStatus(
  app: FastifyInstance,
  id: string,
  statuses: string[],
  timeoutMs = 4000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: "GET", url: `/runs/${id}` });
    const state = res.json().state as { status: string } | undefined;
    if (state && statuses.includes(state.status)) return state;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run did not reach ${statuses.join("/")} in time`);
}

describe("kampong serve — createServeServer", () => {
  let dir: string;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-serve-"));
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function write(source: string): string {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, source);
    return specPath;
  }

  it("starts a run from a webhook POST and pauses at the approval step", async () => {
    const specPath = write(WEBHOOK_SPEC);
    app = createServeServer({ specPath, run: { createModel: fakeModel, fetchImpl: okFetch } });
    await app.ready();

    const hook = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: { message: "where is my refund?" },
    });
    expect(hook.statusCode).toBe(201);
    const runId = hook.json().id as string;

    const paused = await waitForStatus(app, runId, ["awaiting_approval"]);
    // The {{ classify.category }} ref resolved in the approval message.
    expect(paused.pendingApproval.reason).toBe("Approve reply for refund?");

    const approve = await app.inject({
      method: "POST",
      url: `/runs/${runId}/approve`,
      payload: { approved: true },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().state.status).toBe("completed");
  });

  it("accepts a raw (non-JSON) body as the run input", async () => {
    const specPath = write(WEBHOOK_SPEC);
    app = createServeServer({ specPath, run: { createModel: fakeModel, fetchImpl: okFetch } });
    await app.ready();

    const hook = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "text/plain" },
      payload: "where is my refund?",
    });
    expect(hook.statusCode).toBe(201);
    expect(typeof hook.json().id).toBe("string");
  });

  it("404s for an unknown run id", async () => {
    const specPath = write(WEBHOOK_SPEC);
    app = createServeServer({ specPath, run: { createModel: fakeModel, fetchImpl: okFetch } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/runs/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an invalid spec at startup", () => {
    const specPath = write(INVALID_SPEC);
    expect(() => createServeServer({ specPath })).toThrow(ServeSpecInvalidError);
  });

  it("rejects an unsupported trigger type at startup (schema rejects non-webhook)", () => {
    const specPath = write(BAD_TRIGGER_SPEC);
    expect(() => createServeServer({ specPath })).toThrow(ServeSpecInvalidError);
  });
});
