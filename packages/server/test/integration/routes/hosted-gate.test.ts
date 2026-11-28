import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import type { ModelClient } from "@kampong/engine";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createServer } from "../../../src/server.js";
import { HostedRunManager } from "../../../src/run/manager.js";
import { HostedScheduler } from "../../../src/run/scheduler.js";
import { runs, workspaces } from "../../../src/db/schema.js";
import { withWorkspaceScope } from "../../../src/db/workspace-scope.js";

// KAM-340: the release gate for the hosted server, at the level that runs in CI without a cluster.
//   1. Two replicas share one database and both register the same deployed schedule: each tick must fire once.
//   2. Many runs of two workspaces in flight at once: each run's result is its own workspace's, and a workspace
//      reads only its own runs afterwards (in-process run state under concurrency).
// Real Postgres, fake model. Skips without DATABASE_URL.

const DATABASE_URL = process.env["DATABASE_URL"];

const model = (): ModelClient => ({
  async generateText() {
    return "hello";
  },
  async generateStructured<T>() {
    return { result: {}, confidence: 0.99 } as T;
  },
});

const scheduled = (owner: string) => `version: "1.1"
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
        owner: "${owner}"
`;

const owned = (owner: string) => `version: "1.1"
agent:
  id: owned
  name: "Owned"
  role: "r"
  goal: "g"
  workflow:
    - step: stamp
      type: transform
      set:
        owner: "${owner}"
`;

/** The isolation check itself: another workspace asking for this run must be told it does not exist. */
async function assertRunInvisible(
  server: Pick<FastifyInstance, "inject">,
  cookie: string,
  runId: string,
): Promise<void> {
  const peek = await server.inject({
    method: "GET",
    url: `/api/runs/${runId}`,
    headers: { cookie },
  });
  expect(peek.statusCode, `another workspace read run ${runId}`).toBe(404);
}

describe("the isolation check can fail (KAM-340)", () => {
  it("rejects when a server answers another workspace's run read", async () => {
    // A seeded leak: a server that ignores the workspace and hands the run to anyone.
    const leaky = { inject: async () => ({ statusCode: 200 }) } as unknown as Pick<
      FastifyInstance,
      "inject"
    >;
    await expect(assertRunInvisible(leaky, "c", "r")).rejects.toThrow(
      /another workspace read run r/,
    );
  });
});

describe.skipIf(!DATABASE_URL)("Hosted release gate (KAM-340)", () => {
  let db: DbClient;
  let pool: Pool;
  let app: FastifyInstance;
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
    // Limits off: this suite starts many runs at once on purpose.
    app = createServer({
      db,
      run: { createModel: model, limits: { maxConcurrent: 0, maxPerMonth: 0 } },
    });
    await app.ready();
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
        email: `gate-${randomUUID()}@example.com`,
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
    const workspaceId = create.json().id as string;
    createdWorkspaceIds.push(workspaceId);
    return { cookie, workspaceId };
  }

  async function createSpec(cookie: string, source: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/specs",
      headers: { cookie },
      payload: { name: "gate", source },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  it("two replicas sharing a database fire each scheduled tick once, not twice", async () => {
    const { cookie, workspaceId } = await newUserWithWorkspace();
    const specId = await createSpec(cookie, scheduled("ticker"));
    const deployed = await app.inject({
      method: "PUT",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
    });
    const deploymentId = deployed.json().deploymentId as string;

    // Two replicas: each its own run manager and scheduler, one shared Postgres.
    for (let i = 0; i < 2; i++) {
      const manager = new HostedRunManager(db, { createModel: model, limits: { maxPerMonth: 0 } });
      const scheduler = new HostedScheduler(db, manager, { log: () => {} });
      schedulers.push(scheduler);
      await scheduler.register(workspaceId, deploymentId, specId);
    }

    await new Promise((r) => setTimeout(r, 7000));
    await Promise.all(schedulers.map((s) => s.unregister(deploymentId)));

    const rows = await withWorkspaceScope(db, workspaceId, (tx) =>
      tx
        .select({ startedAt: runs.startedAt })
        .from(runs)
        .where(eq(runs.specId, specId))
        .orderBy(asc(runs.startedAt)),
    );
    // A schedule of every second over seven seconds is a handful of ticks. The point is not the count but that no
    // two runs belong to the same tick: ticks are about a second apart, a double fire is milliseconds apart.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i]!.startedAt.getTime() - rows[i - 1]!.startedAt.getTime();
      expect(gap, `runs ${i - 1} and ${i} started ${gap}ms apart`).toBeGreaterThan(400);
    }
  }, 40_000);

  it("runs of two workspaces in flight together keep their own results and their own rows", async () => {
    const a = await newUserWithWorkspace();
    const b = await newUserWithWorkspace();
    const tagA = `A-${randomUUID()}`;
    const tagB = `B-${randomUUID()}`;
    const specA = await createSpec(a.cookie, owned(tagA));
    const specB = await createSpec(b.cookie, owned(tagB));

    const each = 12;
    const started = await Promise.all(
      Array.from({ length: each * 2 }, (_, i) => {
        const side = i % 2 === 0 ? a : b;
        const specId = i % 2 === 0 ? specA : specB;
        return app
          .inject({
            method: "POST",
            url: `/api/specs/${specId}/runs`,
            headers: { cookie: side.cookie },
            payload: { input: `run-${i}` },
          })
          .then((res) => ({ side: i % 2 === 0 ? "a" : "b", res }));
      }),
    );
    for (const { res } of started) expect(res.statusCode, res.body).toBe(201);

    const settle = async (cookie: string, id: string) => {
      for (let i = 0; i < 400; i++) {
        const res = await app.inject({
          method: "GET",
          url: `/api/runs/${id}`,
          headers: { cookie },
        });
        const state = res.json().state;
        if (state.status !== "running") return state;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("run did not finish");
    };

    for (const { side, res } of started) {
      const mine = side === "a" ? a : b;
      const other = side === "a" ? b : a;
      const id = res.json().id as string;
      const state = await settle(mine.cookie, id);
      expect(state.status, JSON.stringify(state)).toBe("completed");
      expect(state.finalOutput.stamp.owner).toBe(side === "a" ? tagA : tagB);
      // The other workspace cannot see this run at all.
      await assertRunInvisible(app, other.cookie, id);
    }

    // And the lists agree: each workspace has exactly its own runs.
    for (const [side, spec] of [
      [a, specA],
      [b, specB],
    ] as const) {
      const rows = await withWorkspaceScope(db, side.workspaceId, (tx) =>
        tx.select({ id: runs.id, specId: runs.specId }).from(runs),
      );
      expect(rows).toHaveLength(each);
      expect(rows.every((r) => r.specId === spec)).toBe(true);
    }
  }, 60_000);
});
