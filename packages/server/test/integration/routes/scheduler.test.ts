import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import type { ModelClient } from "@kampong/engine";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createServer } from "../../../src/server.js";
import { HostedRunManager } from "../../../src/run/manager.js";
import { HostedScheduler } from "../../../src/run/scheduler.js";
import { runs, workspaces } from "../../../src/db/schema.js";
import { withWorkspaceScope } from "../../../src/db/workspace-scope.js";

// KAM-203 (ADR-0056): the hosted scheduler runs a deployed `schedule` trigger, per workspace, and stops when the
// deployment is paused or deleted. Real Postgres, fake model, real (1 second) schedule. Skips without DATABASE_URL.

const DATABASE_URL = process.env["DATABASE_URL"];

const fakeModel = (): ModelClient => ({
  async generateText() {
    return "hello";
  },
  async generateStructured<T>() {
    return { result: {}, confidence: 0.99 } as T;
  },
});

const SCHEDULED_SPEC = `version: "1.1"
agent:
  id: ticker
  name: "Ticker"
  role: "r"
  goal: "g"
  trigger:
    type: schedule
    every: 1s
  workflow:
    - step: shape
      type: transform
      set:
        value: "1"
`;

describe.skipIf(!DATABASE_URL)("Hosted scheduler against a real Postgres", () => {
  let db: DbClient;
  let pool: Pool;
  let app: FastifyInstance;
  let manager: HostedRunManager;
  const createdWorkspaceIds: string[] = [];
  const schedulers: HostedScheduler[] = [];

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
    manager = new HostedRunManager(db, { createModel: fakeModel });
  });

  afterAll(async () => {
    if (!DATABASE_URL) return;
    await Promise.all(schedulers.map((s) => s.stop()));
    for (const id of createdWorkspaceIds) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    await app?.close();
    await pool?.end();
  });

  async function newUserWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const signUp = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: {
        email: `scheduler-${randomUUID()}@example.com`,
        password: "correct-horse-battery-staple",
        name: "T",
      },
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

  async function deploy(cookie: string): Promise<{ specId: string; deploymentId: string }> {
    const created = await app.inject({
      method: "POST",
      url: "/api/specs",
      headers: { cookie },
      payload: { name: "ticker", source: SCHEDULED_SPEC },
    });
    const specId = created.json().id;
    const res = await app.inject({
      method: "PUT",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
    });
    return { specId, deploymentId: res.json().deploymentId };
  }

  const runCount = (workspaceId: string, specId: string): Promise<number> =>
    withWorkspaceScope(db, workspaceId, async (tx) => {
      const rows = await tx.select({ id: runs.id }).from(runs).where(eq(runs.specId, specId));
      return rows.length;
    });

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("condition not met in time");
  }

  it("list_live_deployments returns live deployments of every workspace and not paused ones", async () => {
    const a = await newUserWithWorkspace();
    const b = await newUserWithWorkspace();
    const da = await deploy(a.cookie);
    const dbb = await deploy(b.cookie);
    await app.inject({
      method: "PATCH",
      url: `/api/specs/${dbb.specId}/deployment`,
      headers: { cookie: b.cookie },
      payload: { status: "paused" },
    });
    const result = await db.execute(sql`select * from list_live_deployments()`);
    const ids = (result.rows as Array<{ deployment_id: string }>).map((r) => r.deployment_id);
    expect(ids).toContain(da.deploymentId);
    expect(ids).not.toContain(dbb.deploymentId);
    // The function must not leave a workspace scope behind on the connection.
    const after = await db.execute(sql`select * from list_live_deployments()`);
    expect(after.rows.length).toBe(result.rows.length);
  });

  it("fires a deployed schedule, then stops when the deployment is paused", async () => {
    const { cookie, workspaceId } = await newUserWithWorkspace();
    const { specId, deploymentId } = await deploy(cookie);
    const scheduler = new HostedScheduler(db, manager, { log: () => {} });
    schedulers.push(scheduler);
    await scheduler.register(workspaceId, deploymentId, specId);
    expect(scheduler.registered).toContain(deploymentId);

    await waitFor(async () => (await runCount(workspaceId, specId)) >= 2);
    await scheduler.unregister(deploymentId);
    expect(scheduler.registered).not.toContain(deploymentId);
    const settled = await runCount(workspaceId, specId);
    await new Promise((r) => setTimeout(r, 2500));
    expect(await runCount(workspaceId, specId)).toBe(settled);
  }, 30_000);

  it("start() picks up live scheduled deployments at boot, and never another workspace's runs", async () => {
    const a = await newUserWithWorkspace();
    const b = await newUserWithWorkspace();
    const da = await deploy(a.cookie);
    const dbb = await deploy(b.cookie);
    const scheduler = new HostedScheduler(db, manager, { log: () => {} });
    schedulers.push(scheduler);
    await scheduler.start();
    expect(scheduler.registered).toEqual(
      expect.arrayContaining([da.deploymentId, dbb.deploymentId]),
    );
    await waitFor(
      async () =>
        (await runCount(a.workspaceId, da.specId)) >= 1 &&
        (await runCount(b.workspaceId, dbb.specId)) >= 1,
    );
    // Each workspace sees only its own spec's runs through RLS.
    expect(await runCount(a.workspaceId, dbb.specId)).toBe(0);
    await scheduler.stop();
  }, 30_000);
});
