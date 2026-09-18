import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// KAN-1432 (ADR-0021 Slice D): same hero shape as WEBHOOK_SPEC, plus a Slack
// approval_notifier target.
const SLACK_APPROVAL_SPEC = `version: "1.0"
agent:
  id: triage
  name: "Triage"
  role: "Support"
  goal: "Triage a message."
  trigger:
    type: webhook
  approval_notifier:
    type: slack
    token: \${SLACK_BOT_TOKEN}
    channel: "#approvals"
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
    - step: review
      type: approval
      message: "Approve reply for {{ classify.category }}?"
    - step: send
      type: tool
      tool: send_reply
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

// KAN-1432 (ADR-0021 Slice D): headless approval via Slack -- a run pausing
// posts an interactive Approve/Reject message, and the interaction callback
// (signature-verified) resolves it. Fully offline: fakeSlackFetch stands in
// for both the outbound chat.postMessage call and the response_url update.
describe("kampong serve — headless Slack approval (KAN-1432)", () => {
  let dir: string;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-serve-slack-"));
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

  const SIGNING_SECRET = "test-signing-secret";

  function sign(timestamp: string, rawBody: string): string {
    return `v0=${createHmac("sha256", SIGNING_SECRET)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex")}`;
  }

  function slackInteractionBody(actionId: string, runId: string, userName = "jian"): string {
    const payload = JSON.stringify({
      actions: [{ action_id: actionId, value: JSON.stringify({ runId }) }],
      response_url: "https://hooks.slack.test/response",
      user: { username: userName },
    });
    return `payload=${encodeURIComponent(payload)}`;
  }

  function fakeSlackFetch(): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://slack.com/api/chat.postMessage") {
        return new Response(JSON.stringify({ ok: true, channel: "C1", ts: "1.1" }), {
          status: 200,
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  function startServer(fetchImpl: typeof fetch) {
    const specPath = write(SLACK_APPROVAL_SPEC);
    app = createServeServer({
      specPath,
      run: {
        createModel: fakeModel,
        fetchImpl: okFetch,
        env: { SLACK_BOT_TOKEN: "xoxb-test", SLACK_SIGNING_SECRET: SIGNING_SECRET },
        slackFetchImpl: fetchImpl,
      },
    });
    return app!;
  }

  it("posts an interactive Slack message when a run pauses for approval", async () => {
    const { fetchImpl, calls } = fakeSlackFetch();
    const server = startServer(fetchImpl);
    await server.ready();

    const hook = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: { message: "where is my refund?" },
    });
    const runId = hook.json().id as string;
    await waitForStatus(server, runId, ["awaiting_approval"]);

    await vi.waitFor(() => expect(calls).toContain("https://slack.com/api/chat.postMessage"));
  });

  it("a correctly signed Approve interaction resolves the run and completes it", async () => {
    const { fetchImpl } = fakeSlackFetch();
    const server = startServer(fetchImpl);
    await server.ready();

    const hook = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: { message: "where is my refund?" },
    });
    const runId = hook.json().id as string;
    await waitForStatus(server, runId, ["awaiting_approval"]);

    const body = slackInteractionBody("kampong_approve", runId);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const interaction = await server.inject({
      method: "POST",
      url: "/slack/interactions",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": sign(timestamp, body),
      },
      payload: body,
    });
    expect(interaction.statusCode).toBe(200);

    const final = await waitForStatus(server, runId, ["completed", "failed"]);
    expect(final.status).toBe("completed");
  });

  it("a correctly signed Reject interaction rejects the run", async () => {
    const { fetchImpl } = fakeSlackFetch();
    const server = startServer(fetchImpl);
    await server.ready();

    const hook = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: { message: "where is my refund?" },
    });
    const runId = hook.json().id as string;
    await waitForStatus(server, runId, ["awaiting_approval"]);

    const body = slackInteractionBody("kampong_reject", runId);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const interaction = await server.inject({
      method: "POST",
      url: "/slack/interactions",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": sign(timestamp, body),
      },
      payload: body,
    });
    expect(interaction.statusCode).toBe(200);

    const final = await waitForStatus(server, runId, ["completed", "rejected", "failed"]);
    expect(final.status).toBe("rejected");
  });

  it("rejects an interaction with an invalid signature (401), and the run stays paused", async () => {
    const { fetchImpl } = fakeSlackFetch();
    const server = startServer(fetchImpl);
    await server.ready();

    const hook = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: { message: "where is my refund?" },
    });
    const runId = hook.json().id as string;
    await waitForStatus(server, runId, ["awaiting_approval"]);

    const body = slackInteractionBody("kampong_approve", runId);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const interaction = await server.inject({
      method: "POST",
      url: "/slack/interactions",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": "v0=deadbeef",
      },
      payload: body,
    });
    expect(interaction.statusCode).toBe(401);

    const status = await server.inject({ method: "GET", url: `/runs/${runId}` });
    expect(status.json().state.status).toBe("awaiting_approval");
  });

  it("acks (200) a second interaction for an already-resolved run instead of crashing", async () => {
    const { fetchImpl } = fakeSlackFetch();
    const server = startServer(fetchImpl);
    await server.ready();

    const hook = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: { message: "where is my refund?" },
    });
    const runId = hook.json().id as string;
    await waitForStatus(server, runId, ["awaiting_approval"]);

    const approveOnce = async () => {
      const body = slackInteractionBody("kampong_approve", runId);
      const timestamp = String(Math.floor(Date.now() / 1000));
      return server!.inject({
        method: "POST",
        url: "/slack/interactions",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": sign(timestamp, body),
        },
        payload: body,
      });
    };

    const first = await approveOnce();
    expect(first.statusCode).toBe(200);
    await waitForStatus(server, runId, ["completed", "failed"]);

    const second = await approveOnce();
    expect(second.statusCode).toBe(200);
  });
});
