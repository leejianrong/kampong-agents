import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { ModelClient } from "@kampong/engine";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createServer } from "../../../src/server.js";
import { workspaces } from "../../../src/db/schema.js";

// KAN-1231 (ADR-0014): the durable hosted-execution routes (start a run,
// read its persisted state) end to end through the server's inject() against
// a real Postgres, with a fake ModelClient injected via the `run.createModel`
// seam so a run completes deterministically with no network and no stored
// BYOK key. Skips without DATABASE_URL; runs in CI against the non-superuser
// role (KAN-1388). Local setup mirrors the sibling suites.

const DATABASE_URL = process.env["DATABASE_URL"];

// Completes a run in one step: a high-confidence structured result, so the
// greeter spec below finishes without hitting an approval gate.
function fakeModel(): ModelClient {
  return {
    async generateText() {
      return "hello";
    },
    async generateStructured<T>() {
      return { result: { greeted: true }, confidence: 0.99 } as T;
    },
  };
}

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

describe.skipIf(!DATABASE_URL)("Hosted run routes against a real Postgres", () => {
  let db: DbClient;
  let pool: Pool;
  let app: FastifyInstance;
  const createdWorkspaceIds: string[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await runMigrations(DATABASE_URL);
    ({ db, pool } = createDbClient(DATABASE_URL));

    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-not-for-prod-0123456789";
    process.env["BETTER_AUTH_URL"] = "http://localhost:3000";
    delete process.env["GITHUB_CLIENT_ID"];
    delete process.env["GITHUB_CLIENT_SECRET"];

    app = createServer({ db, run: { createModel: fakeModel } });
    await app.ready();
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
    return `runs-${randomUUID()}@example.com`;
  }

  async function newUserWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
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
    const workspaceId = create.json().id;
    createdWorkspaceIds.push(workspaceId);
    return { cookie, workspaceId };
  }

  async function createSpec(cookie: string): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/specs",
      headers: { cookie },
      payload: { name: "greeter", source: GREETER_SPEC },
    });
    return created.json().id;
  }

  async function waitForTerminal(cookie: string, id: string, timeoutMs = 4000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await app.inject({ method: "GET", url: `/api/runs/${id}`, headers: { cookie } });
      const status = res.json().state?.status;
      if (status && status !== "running") return res.json().state;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("run did not reach a terminal state in time");
  }

  /** Reads a run's persisted row via scoped raw SQL (runs has RLS). */
  async function rawRun(workspaceId: string, id: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      const { rows } = await client.query<{
        status: string;
        trace_json: unknown[];
        completed_at: Date | null;
      }>(`SELECT status, trace_json, completed_at FROM runs WHERE id = $1 AND workspace_id = $2`, [
        id,
        workspaceId,
      ]);
      await client.query("COMMIT");
      return rows[0];
    } finally {
      client.release();
    }
  }

  /**
   * Polls the persisted `runs` row until its status is terminal. The live
   * in-memory run reaches "completed" a beat before the async persist commits,
   * so any assertion about the DB row (or a fresh server reading it) must wait
   * on the persisted state, not just the live state `waitForTerminal` sees.
   */
  async function waitForPersistedTerminal(workspaceId: string, id: string, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await rawRun(workspaceId, id);
      if (row && ["completed", "rejected", "failed"].includes(row.status)) return row;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("run did not persist a terminal state in time");
  }

  it("rejects an unauthenticated start with 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/specs/${randomUUID()}/runs`,
      payload: { input: "hi" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("starts a run, drives it to completion, and persists the terminal state to the runs table", async () => {
    const { cookie, workspaceId } = await newUserWithWorkspace();
    const specId = await createSpec(cookie);

    const start = await app.inject({
      method: "POST",
      url: `/api/specs/${specId}/runs`,
      headers: { cookie },
      payload: { input: "please greet" },
    });
    expect(start.statusCode).toBe(201);
    const runId = start.json().id;
    expect(runId).toMatch(/^[0-9a-f]{8}-/i);
    expect(start.json().state.status).toBe("running");

    const finalState = (await waitForTerminal(cookie, runId)) as {
      status: string;
      trace: unknown[];
    };
    expect(finalState.status).toBe("completed");
    expect(finalState.trace.length).toBeGreaterThan(0);

    // Persisted, not just in memory: the runs row reflects the terminal state.
    const row = await waitForPersistedTerminal(workspaceId, runId);
    expect(row.status).toBe("completed");
    expect(Array.isArray(row.trace_json) && row.trace_json.length).toBeGreaterThan(0);
    expect(row.completed_at).not.toBeNull();
  });

  it("reads a completed run back from the database on a fresh server (durability across a restart)", async () => {
    const { cookie, workspaceId } = await newUserWithWorkspace();
    const specId = await createSpec(cookie);
    const start = await app.inject({
      method: "POST",
      url: `/api/specs/${specId}/runs`,
      headers: { cookie },
      payload: { input: "greet" },
    });
    const runId = start.json().id;
    await waitForPersistedTerminal(workspaceId, runId);

    // A second server instance shares the database but has NO live run in
    // memory -- so its GET can only succeed by reading the persisted row.
    const fresh = createServer({ db });
    await fresh.ready();
    try {
      const res = await fresh.inject({
        method: "GET",
        url: `/api/runs/${runId}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().state.status).toBe("completed");
    } finally {
      await fresh.close();
    }
  });

  it("returns 404 for an unknown run id", async () => {
    const { cookie } = await newUserWithWorkspace();
    const res = await app.inject({
      method: "GET",
      url: `/api/runs/${randomUUID()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when starting a run for a spec that isn't in the workspace", async () => {
    const { cookie } = await newUserWithWorkspace();
    const res = await app.inject({
      method: "POST",
      url: `/api/specs/${randomUUID()}/runs`,
      headers: { cookie },
      payload: { input: "hi" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("isolates runs per workspace: one workspace cannot read another's run", async () => {
    const a = await newUserWithWorkspace();
    const b = await newUserWithWorkspace();
    const specId = await createSpec(a.cookie);
    const start = await app.inject({
      method: "POST",
      url: `/api/specs/${specId}/runs`,
      headers: { cookie: a.cookie },
      payload: { input: "greet" },
    });
    const runId = start.json().id;
    await waitForTerminal(a.cookie, runId);

    const asB = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}`,
      headers: { cookie: b.cookie },
    });
    expect(asB.statusCode).toBe(404);
  });
});
