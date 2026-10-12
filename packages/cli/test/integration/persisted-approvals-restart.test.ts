import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@kampong/engine";
import { createServeServer } from "../../src/serve-server.js";

// KAN-1854 (ADR-0042): a run paused for approval survives a restart. "Restart" here is a second
// createServeServer (a new RunManager, nothing shared in memory) over the same file-backed SQLite
// store, which is exactly what a fresh `kampong serve` process is. Offline: a fake model, a recorded
// Slack API response and a recorded tool response.

const SPEC = `version: "1.0"
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

const SIGNING_SECRET = "test-signing-secret";

let modelCalls = 0;
const model = (): ModelClient => ({
  async generateText() {
    modelCalls++;
    return "drafted";
  },
  async generateStructured<T>() {
    modelCalls++;
    return { result: { category: "refund" }, confidence: 0.99 } as T;
  },
});

describe("persisted approvals survive a restart (KAN-1854)", () => {
  let dir: string;
  let specPath: string;
  const apps: FastifyInstance[] = [];
  let toolCalls: number;
  let slackBodies: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-persisted-approvals-"));
    specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SPEC);
    toolCalls = 0;
    slackBodies = [];
    modelCalls = 0;
  });
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const toolFetch = (async () => {
    toolCalls++;
    return new Response(JSON.stringify({ status: "sent" }), { status: 200 });
  }) as unknown as typeof fetch;

  const slackFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "https://slack.com/api/chat.postMessage") {
      slackBodies.push(String(init?.body));
      return new Response(JSON.stringify({ ok: true, channel: "C1", ts: "1.1" }), { status: 200 });
    }
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  /** One "process": a fresh server and RunManager over the spec directory's store. */
  async function boot(): Promise<FastifyInstance> {
    const app = createServeServer({
      specPath,
      run: {
        createModel: model,
        fetchImpl: toolFetch,
        env: { SLACK_BOT_TOKEN: "xoxb-test", SLACK_SIGNING_SECRET: SIGNING_SECRET },
        slackFetchImpl: slackFetch,
      },
    });
    apps.push(app);
    await app.ready();
    return app;
  }

  async function pauseARun(app: FastifyInstance): Promise<string> {
    const hook = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: { message: "where is my refund?" },
    });
    const runId = hook.json().id as string;
    await vi.waitFor(async () => {
      const res = await app.inject({ method: "GET", url: `/runs/${runId}` });
      expect(res.json().state.status).toBe("awaiting_approval");
    });
    const run = await app.inject({ method: "GET", url: `/runs/${runId}` });
    return run.json().state.pendingApproval.key as string;
  }

  async function restart(app: FastifyInstance): Promise<FastifyInstance> {
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    return boot();
  }

  const approve = (app: FastifyInstance, key: string, approved = true) =>
    app.inject({
      method: "POST",
      url: `/approvals/${key}/approve`,
      headers: { "content-type": "application/json" },
      payload: { approved },
    });

  it("approving by key after a restart resumes from the paused step and clears the record", async () => {
    const first = await boot();
    const key = await pauseARun(first);
    expect(existsSync(join(dir, ".kampong", "state.db"))).toBe(true);
    await vi.waitFor(() => expect(slackBodies.length).toBe(1));
    // The Slack button carries the key, so it still works once the run id is gone.
    expect(decodeURIComponent(slackBodies[0]!)).toContain(key);
    expect(modelCalls).toBe(1);

    const second = await restart(first);
    const listed = await second.inject({ method: "GET", url: "/approvals" });
    expect(listed.json().approvals).toHaveLength(1);
    expect(listed.json().approvals[0]).toMatchObject({
      key,
      step: "review",
      stepIndex: 1,
      agentId: "triage",
    });

    const res = await approve(second, key);
    expect(res.statusCode).toBe(200);
    expect(res.json().state.status).toBe("completed");
    expect(res.json().state.finalOutput).toMatchObject({
      classify: { category: "refund" },
      review: { approved: true },
      send: "sent",
    });
    expect(toolCalls).toBe(1);
    expect(modelCalls).toBe(1); // classify was not run again

    expect((await second.inject({ method: "GET", url: "/approvals" })).json().approvals).toEqual(
      [],
    );
    expect((await approve(second, key)).statusCode).toBe(404);
    expect(toolCalls).toBe(1);
  });

  it("a signed Slack Approve click on the key resolves it after a restart", async () => {
    const first = await boot();
    const key = await pauseARun(first);
    const second = await restart(first);

    const payload = JSON.stringify({
      actions: [{ action_id: "kampong_approve", value: JSON.stringify({ runId: key }) }],
      response_url: "https://hooks.slack.test/response",
      user: { username: "jian" },
    });
    const body = `payload=${encodeURIComponent(payload)}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
    const res = await second.inject({
      method: "POST",
      url: "/slack/interactions",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(toolCalls).toBe(1));
    expect((await second.inject({ method: "GET", url: "/approvals" })).json().approvals).toEqual(
      [],
    );
  });

  it("a double approve after a restart runs the tool once", async () => {
    const first = await boot();
    const key = await pauseARun(first);
    const second = await restart(first);

    const [a, b] = await Promise.all([approve(second, key), approve(second, key)]);
    // The loser sees either no record (404) or a lost claim (409), depending on interleaving.
    expect([a.statusCode, b.statusCode].filter((c) => c === 200)).toHaveLength(1);
    expect([a.statusCode, b.statusCode].find((c) => c !== 200)).toBeOneOf([404, 409]);
    expect(toolCalls).toBe(1);
  });

  it("two processes live at once: only one of two approvals by key resumes the run", async () => {
    const first = await boot();
    const key = await pauseARun(first);
    const other = await boot(); // a second live process over the same store

    const [a, b] = await Promise.all([approve(first, key), approve(other, key)]);
    // The loser sees either no record (404) or a lost claim (409), depending on interleaving.
    expect([a.statusCode, b.statusCode].filter((c) => c === 200)).toHaveLength(1);
    expect([a.statusCode, b.statusCode].find((c) => c !== 200)).toBeOneOf([404, 409]);
    expect(toolCalls).toBe(1);
  });

  it("a rejection by key after a restart ends the run and calls nothing", async () => {
    const first = await boot();
    const key = await pauseARun(first);
    const second = await restart(first);
    const res = await approve(second, key, false);
    expect(res.statusCode).toBe(200);
    expect(res.json().state.status).toBe("rejected");
    expect(toolCalls).toBe(0);
    expect((await second.inject({ method: "GET", url: "/approvals" })).json().approvals).toEqual(
      [],
    );
  });

  it("refuses to resume when the spec changed, then resumes once it is restored", async () => {
    const first = await boot();
    const key = await pauseARun(first);
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const original = readFileSync(specPath, "utf8");
    writeFileSync(specPath, original.replace("Triage a message.", "Triage differently."));
    const changed = await boot();
    const refused = await approve(changed, key);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/spec changed/);
    expect(toolCalls).toBe(0);
    // Still pending: nothing was claimed.
    expect(
      (await changed.inject({ method: "GET", url: "/approvals" })).json().approvals,
    ).toHaveLength(1);

    writeFileSync(specPath, original);
    const restored = await restart(changed);
    expect((await approve(restored, key)).statusCode).toBe(200);
    expect(toolCalls).toBe(1);
  });

  it("an unknown key is a 404", async () => {
    const app = await boot();
    expect((await approve(app, "no-such-key")).statusCode).toBe(404);
  });

  it("the existing in-memory approve route still works within one process", async () => {
    const app = await boot();
    const hook = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: { message: "hi" },
    });
    const runId = hook.json().id as string;
    await vi.waitFor(async () => {
      const res = await app.inject({ method: "GET", url: `/runs/${runId}` });
      expect(res.json().state.status).toBe("awaiting_approval");
    });
    const res = await app.inject({
      method: "POST",
      url: `/runs/${runId}/approve`,
      headers: { "content-type": "application/json" },
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state.status).toBe("completed");
    expect((await app.inject({ method: "GET", url: "/approvals" })).json().approvals).toEqual([]);
  });
});
