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

// KAM-323: what one workspace may use. Against a real Postgres, with a model that never answers so a run stays
// `running` for as long as the test needs. Skips without DATABASE_URL; runs in CI.

const DATABASE_URL = process.env["DATABASE_URL"];

const SPEC = `version: "1.0"
agent:
  id: slow
  name: "Slow"
  role: "r"
  goal: "g"
  workflow:
    - step: greet
      action: say_hello
`;

describe.skipIf(!DATABASE_URL)("Workspace run limits (KAM-323)", () => {
  let db: DbClient;
  let pool: Pool;
  const apps: FastifyInstance[] = [];
  const createdWorkspaceIds: string[] = [];
  const release: Array<() => void> = [];

  // A model that holds the run until the test lets go.
  const hangingModel: ModelClient = {
    async generateText() {
      await new Promise<void>((r) => release.push(r));
      return "late";
    },
    async generateStructured<T>() {
      await new Promise<void>((r) => release.push(r));
      return { result: {}, confidence: 1 } as T;
    },
  };

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await runMigrations(DATABASE_URL);
    ({ db, pool } = createDbClient(DATABASE_URL));
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-not-for-prod-0123456789";
    process.env["BETTER_AUTH_URL"] = "http://localhost:3000";
    process.env["BYOK_ROOT_KEY"] ??= Buffer.alloc(32, 7).toString("base64");
  });

  afterAll(async () => {
    if (!DATABASE_URL) return;
    for (const r of release) r();
    for (const id of createdWorkspaceIds) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    for (const app of apps) await app.close();
    await pool?.end();
  });

  async function setup(limits: {
    maxConcurrent?: number;
    maxPerMonth?: number;
    maxRuntimeMs?: number;
  }) {
    const app = createServer({ db, run: { createModel: () => hangingModel, limits } });
    await app.ready();
    apps.push(app);
    const signUp = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: {
        email: `lim-${randomUUID()}@example.com`,
        password: "correct-horse-battery-staple",
        name: "T",
      },
    });
    const setCookie = signUp.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
    const org = await app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      headers: { cookie, origin: "http://localhost:3000" },
      payload: { name: "WS", slug: `ws-${randomUUID()}` },
    });
    createdWorkspaceIds.push(org.json().id);
    const created = await app.inject({
      method: "POST",
      url: "/api/specs",
      headers: { cookie },
      payload: { name: "slow", source: SPEC },
    });
    const specId = created.json().id as string;
    const start = () =>
      app.inject({
        method: "POST",
        url: `/api/specs/${specId}/runs`,
        headers: { cookie },
        payload: { input: "go" },
      });
    return { app, cookie, specId, start };
  }

  it("refuses a run over the concurrency cap with 429 and a reason, and frees the slot when one ends", async () => {
    const { app, cookie, start } = await setup({ maxConcurrent: 1, maxRuntimeMs: 0 });
    const first = await start();
    expect(first.statusCode, first.body).toBe(201);
    const second = await start();
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    expect(second.json()).toMatchObject({ success: false, code: "concurrency" });
    expect(second.json().error).toMatch(/already has 1 runs going/);

    // Let the first finish; a new run then fits.
    for (const r of release.splice(0)) r();
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/api/runs/${first.json().id}`,
        headers: { cookie },
      });
      if (res.json().state.status !== "running") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect((await start()).statusCode).toBe(201);
  }, 30_000);

  it("at the monthly ceiling a webhook is refused once, then the deployment is paused with the reason", async () => {
    const { app, cookie, specId } = await setup({ maxPerMonth: 1, maxRuntimeMs: 0 });
    const deployed = await app.inject({
      method: "PUT",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
    });
    const hook = deployed.json() as { webhookPath: string };
    const fire = () =>
      app.inject({
        method: "POST",
        url: hook.webhookPath,
        headers: { "content-type": "application/json" },
        payload: "{}",
      });
    expect((await fire()).statusCode).toBe(201);
    const over = await fire();
    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe("monthly");

    const read = await app.inject({
      method: "GET",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
    });
    expect(read.json()).toMatchObject({ status: "paused", pausedReason: "monthly_limit" });
    // Paused, so the address answers like one that does not exist.
    expect((await fire()).statusCode).toBe(404);

    const audit = await app.inject({
      method: "GET",
      url: "/api/audit?action=deployment.paused_by_limit",
      headers: { cookie },
    });
    expect(audit.json().events).toHaveLength(1);

    // A person resuming clears the reason.
    const resumed = await app.inject({
      method: "PATCH",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
      payload: { status: "live" },
    });
    expect(resumed.statusCode).toBe(200);
    const again = await app.inject({
      method: "GET",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
    });
    expect(again.json().pausedReason).toBeNull();
  }, 30_000);

  it("stops a run that takes too long and records it as failed with the reason", async () => {
    const { app, cookie, start } = await setup({ maxRuntimeMs: 300 });
    const started = await start();
    expect(started.statusCode, started.body).toBe(201);
    let state: { status: string; error?: string } = { status: "running" };
    for (let i = 0; i < 200 && state.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const res = await app.inject({
        method: "GET",
        url: `/api/runs/${started.json().id}`,
        headers: { cookie },
      });
      state = res.json().state;
    }
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/^Stopped: this run took longer than/);
    // The engine finishing late must not overwrite it.
    for (const r of release.splice(0)) r();
    await new Promise((r) => setTimeout(r, 300));
    const after = await app.inject({
      method: "GET",
      url: `/api/runs/${started.json().id}`,
      headers: { cookie },
    });
    expect(after.json().state.status).toBe("failed");
    const audit = await app.inject({
      method: "GET",
      url: "/api/audit?action=run.timeout",
      headers: { cookie },
    });
    expect(audit.json().events).toHaveLength(1);
  }, 30_000);
});
