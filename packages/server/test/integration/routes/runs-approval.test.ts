import http from "node:http";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { ModelClient } from "@kampong/engine";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createServer } from "../../../src/server.js";
import { workspaces } from "../../../src/db/schema.js";

// KAN-1425 (ADR-0014): the interactive half of hosted execution -- the HITL
// approval route and the SSE run-progress stream, both workspace-scoped. Uses
// the same tool-requires-approval spec + fake ModelClient + mocked fetch the
// CLI's run-endpoints test uses, so a run deterministically pauses at an
// approval gate and completes once approved -- no network. Skips without
// DATABASE_URL; runs in CI against the non-superuser role (KAN-1388).

const DATABASE_URL = process.env["DATABASE_URL"];

// Eligible refund -> the condition routes to execute_tool(issue_refund), whose
// requires_approval:true pauses the run awaiting approval.
function fakeModel(): ModelClient {
  return {
    async generateText() {
      return "ok";
    },
    async generateStructured<T>() {
      return { result: { eligible: true }, confidence: 0.99 } as T;
    },
  };
}

// The tool's http_request never really fires -- this canned Response stands in.
const fetchImpl = (async () =>
  new Response(JSON.stringify({ status: "refunded" }), { status: 200 })) as unknown as typeof fetch;

const TOOL_APPROVAL_SPEC = `version: "1.0"
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

const GREETER_SPEC = `version: "1.0"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  workflow:
    - step: greet
      action: say_hello
`;

describe.skipIf(!DATABASE_URL)("Hosted run approval + SSE routes against a real Postgres", () => {
  let db: DbClient;
  let pool: Pool;
  let app: FastifyInstance;
  let baseUrl: string;
  const createdWorkspaceIds: string[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await runMigrations(DATABASE_URL);
    ({ db, pool } = createDbClient(DATABASE_URL));

    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-not-for-prod-0123456789";
    process.env["BETTER_AUTH_URL"] = "http://localhost:3000";
    delete process.env["GITHUB_CLIENT_ID"];
    delete process.env["GITHUB_CLIENT_SECRET"];

    app = createServer({ db, run: { createModel: fakeModel, fetchImpl } });
    // A real listening socket (not just ready()) so the live SSE test can open
    // a genuine streaming connection app.inject() can't model.
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (!DATABASE_URL) return;
    for (const id of createdWorkspaceIds) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    await app?.close();
    await pool?.end();
  });

  function uniqueEmail(): string {
    return `runs-approval-${randomUUID()}@example.com`;
  }

  async function newUserWithWorkspace(): Promise<{ cookie: string }> {
    const signUp = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: uniqueEmail(), password: "correct-horse-battery-staple", name: "T" },
    });
    const setCookie = signUp.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
    const create = await app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      headers: { cookie, origin: "http://localhost:3000" },
      payload: { name: "WS", slug: `ws-${randomUUID()}` },
    });
    createdWorkspaceIds.push(create.json().id);
    return { cookie };
  }

  async function createSpec(cookie: string, source: string): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/specs",
      headers: { cookie },
      payload: { name: "spec", source },
    });
    return created.json().id;
  }

  async function startRun(cookie: string, specId: string): Promise<string> {
    const start = await app.inject({
      method: "POST",
      url: `/api/specs/${specId}/runs`,
      headers: { cookie },
      payload: { input: "Refund order #1" },
    });
    return start.json().id;
  }

  async function waitForStatus(cookie: string, id: string, statuses: string[], timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await app.inject({ method: "GET", url: `/api/runs/${id}`, headers: { cookie } });
      const state = res.json().state;
      if (state && statuses.includes(state.status)) return state;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`run did not reach ${statuses.join("/")} in time`);
  }

  describe("approval", () => {
    it("pauses at a requires_approval tool and completes once approved", async () => {
      const { cookie } = await newUserWithWorkspace();
      const specId = await createSpec(cookie, TOOL_APPROVAL_SPEC);
      const runId = await startRun(cookie, specId);

      const paused = await waitForStatus(cookie, runId, ["awaiting_approval"]);
      expect(paused.pendingApproval).toMatchObject({ kind: "tool", toolName: "issue_refund" });

      const approve = await app.inject({
        method: "POST",
        url: `/api/runs/${runId}/approve`,
        headers: { cookie },
        payload: { approved: true },
      });
      expect(approve.statusCode).toBe(200);
      expect(approve.json().state.status).toBe("completed");
      expect(approve.json().state.finalOutput.decide).toBe("refunded");
    });

    it("rejects a run and never completes when approval is denied", async () => {
      const { cookie } = await newUserWithWorkspace();
      const specId = await createSpec(cookie, TOOL_APPROVAL_SPEC);
      const runId = await startRun(cookie, specId);
      await waitForStatus(cookie, runId, ["awaiting_approval"]);

      const reject = await app.inject({
        method: "POST",
        url: `/api/runs/${runId}/approve`,
        headers: { cookie },
        payload: { approved: false, reason: "Looks fraudulent." },
      });
      expect(reject.statusCode).toBe(200);
      expect(reject.json().state.status).toBe("rejected");
    });

    it("400 when `approved` is missing, 404 for an unknown run", async () => {
      const { cookie } = await newUserWithWorkspace();
      const specId = await createSpec(cookie, TOOL_APPROVAL_SPEC);
      const runId = await startRun(cookie, specId);
      await waitForStatus(cookie, runId, ["awaiting_approval"]);

      const bad = await app.inject({
        method: "POST",
        url: `/api/runs/${runId}/approve`,
        headers: { cookie },
        payload: {},
      });
      expect(bad.statusCode).toBe(400);

      const unknown = await app.inject({
        method: "POST",
        url: `/api/runs/${randomUUID()}/approve`,
        headers: { cookie },
        payload: { approved: true },
      });
      expect(unknown.statusCode).toBe(404);
    });

    it("409 when approving a run that isn't awaiting approval", async () => {
      const { cookie } = await newUserWithWorkspace();
      const specId = await createSpec(cookie, GREETER_SPEC);
      const runId = await startRun(cookie, specId);
      await waitForStatus(cookie, runId, ["completed"]);

      const late = await app.inject({
        method: "POST",
        url: `/api/runs/${runId}/approve`,
        headers: { cookie },
        payload: { approved: true },
      });
      expect(late.statusCode).toBe(409);
    });

    it("one workspace cannot approve another workspace's paused run", async () => {
      const a = await newUserWithWorkspace();
      const b = await newUserWithWorkspace();
      const specId = await createSpec(a.cookie, TOOL_APPROVAL_SPEC);
      const runId = await startRun(a.cookie, specId);
      await waitForStatus(a.cookie, runId, ["awaiting_approval"]);

      const asB = await app.inject({
        method: "POST",
        url: `/api/runs/${runId}/approve`,
        headers: { cookie: b.cookie },
        payload: { approved: true },
      });
      expect(asB.statusCode).toBe(404);

      // A's run is still approvable (B's attempt didn't touch it).
      const asA = await app.inject({
        method: "POST",
        url: `/api/runs/${runId}/approve`,
        headers: { cookie: a.cookie },
        payload: { approved: true },
      });
      expect(asA.statusCode).toBe(200);
    });
  });

  describe("SSE stream", () => {
    it("404s for an unknown run", async () => {
      const { cookie } = await newUserWithWorkspace();
      const res = await app.inject({
        method: "GET",
        url: `/api/runs/${randomUUID()}/events`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it("streams the opening state frame and live event frames over a real connection", async () => {
      const { cookie } = await newUserWithWorkspace();
      const specId = await createSpec(cookie, TOOL_APPROVAL_SPEC);
      const runId = await startRun(cookie, specId);
      await waitForStatus(cookie, runId, ["awaiting_approval"]);

      const received = await new Promise<string>((resolve, reject) => {
        let buffer = "";
        let approved = false;
        const req = http.get(
          {
            host: "127.0.0.1",
            port: Number(new URL(baseUrl).port),
            path: `/api/runs/${runId}/events`,
            headers: { cookie },
          },
          (res) => {
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              buffer += chunk;
              // Once the opening state frame arrives, approve to generate the
              // post-subscription events the stream should deliver.
              if (!approved && buffer.includes('"type":"state"')) {
                approved = true;
                void app.inject({
                  method: "POST",
                  url: `/api/runs/${runId}/approve`,
                  headers: { cookie },
                  payload: { approved: true },
                });
              }
              if (buffer.includes('"type":"event"')) {
                req.destroy();
                resolve(buffer);
              }
            });
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        setTimeout(() => {
          req.destroy();
          reject(new Error("no SSE event frame received in time"));
        }, 5000);
      });

      expect(received).toContain('"type":"state"');
      expect(received).toContain('"type":"event"');
    });
  });
});
