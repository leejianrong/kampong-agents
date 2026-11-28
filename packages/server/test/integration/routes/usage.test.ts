import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { ModelClient, ModelUsage } from "@kampong/engine";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createServer } from "../../../src/server.js";
import { runs, workspaces } from "../../../src/db/schema.js";
import { withWorkspaceScope } from "../../../src/db/workspace-scope.js";

// KAM-325: the usage report and the run usage behind it. Real Postgres. Skips without DATABASE_URL.

const DATABASE_URL = process.env["DATABASE_URL"];

const SPEC = (model: string) => `version: "1.0"
agent:
  id: metered
  name: "Metered"
  role: "r"
  goal: "g"
  model:
    provider: ollama
    name: ${model}
  workflow:
    - step: greet
      action: say_hello
`;

describe.skipIf(!DATABASE_URL)("Usage report (KAM-325)", () => {
  let db: DbClient;
  let pool: Pool;
  let app: FastifyInstance;
  const createdWorkspaceIds: string[] = [];

  // A model that reports what a real client would: 1000 tokens in and 200 out per call.
  const meteredModel = (hooks: { onUsage: (u: ModelUsage) => void }): ModelClient => ({
    async generateText() {
      hooks.onUsage({ inputTokens: 1000, outputTokens: 200 });
      return "hello";
    },
    async generateStructured<T>() {
      hooks.onUsage({ inputTokens: 1000, outputTokens: 200 });
      return { result: { ok: true }, confidence: 0.99 } as T;
    },
  });

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await runMigrations(DATABASE_URL);
    ({ db, pool } = createDbClient(DATABASE_URL));
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-not-for-prod-0123456789";
    process.env["BETTER_AUTH_URL"] = "http://localhost:3000";
    app = createServer({
      db,
      run: {
        createModel: (_spec, hooks) => meteredModel(hooks),
        // $1 per million in, $2 per million out: 1000 in and 200 out cost $0.0014.
        pricing: { priced: { inputPerMTok: 1, outputPerMTok: 2 } },
        limits: { maxConcurrent: 0, maxPerMonth: 50, maxRuntimeMs: 0 },
      },
    });
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

  async function newUserWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const signUp = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: {
        email: `usage-${randomUUID()}@example.com`,
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

  async function runSpec(cookie: string, model: string): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/specs",
      headers: { cookie },
      payload: { name: `m-${model}`, source: SPEC(model) },
    });
    const specId = created.json().id as string;
    const start = await app.inject({
      method: "POST",
      url: `/api/specs/${specId}/runs`,
      headers: { cookie },
      payload: { input: "go" },
    });
    expect(start.statusCode, start.body).toBe(201);
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/api/runs/${start.json().id}`,
        headers: { cookie },
      });
      if (res.json().state.status !== "running") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    // The terminal write is queued behind the last event; give it a moment.
    await new Promise((r) => setTimeout(r, 200));
    return specId;
  }

  it("a run records its tokens, and cost only when its model has a price", async () => {
    const { cookie, workspaceId } = await newUserWithWorkspace();
    await runSpec(cookie, "priced");
    await runSpec(cookie, "unpriced");
    const rows = await withWorkspaceScope(db, workspaceId, (tx) =>
      tx
        .select({ tokensIn: runs.tokensIn, tokensOut: runs.tokensOut, costUsd: runs.costUsd })
        .from(runs),
    );
    expect(rows).toHaveLength(2);
    const priced = rows.find((r) => r.costUsd !== null)!;
    expect(priced.tokensIn).toBe(1000);
    expect(priced.tokensOut).toBe(200);
    expect(Number(priced.costUsd)).toBeCloseTo(0.0014, 6);
    const unpriced = rows.find((r) => r.costUsd === null)!;
    expect(unpriced.tokensIn).toBe(1000);
  }, 30_000);

  it("the report matches the stored runs, by day and by deployment, and shows the limits", async () => {
    const { cookie, workspaceId } = await newUserWithWorkspace();
    const specId = await runSpec(cookie, "priced");
    // Seed two earlier days of known usage straight into the table, so the figures are checkable by hand.
    const day = (n: number) => new Date(Date.now() - n * 86_400_000);
    await withWorkspaceScope(db, workspaceId, async (tx) => {
      await tx.insert(runs).values([
        {
          workspaceId,
          specId,
          input: "",
          status: "completed",
          traceJson: [],
          startedAt: day(1),
          tokensIn: 500,
          tokensOut: 100,
          costUsd: "0.001000",
        },
        {
          workspaceId,
          specId,
          input: "",
          status: "completed",
          traceJson: [],
          startedAt: day(1),
          tokensIn: 300,
          tokensOut: 50,
          costUsd: "0.000500",
        },
        {
          workspaceId,
          specId,
          input: "",
          status: "completed",
          traceJson: [],
          startedAt: day(2),
          tokensIn: 40,
          tokensOut: 10,
          costUsd: null,
        },
      ]);
    });

    const res = await app.inject({ method: "GET", url: "/api/usage?days=7", headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json();
    expect(report.version).toBe(1);
    // Today's real run (1000 in, 200 out, $0.0014) plus the seeded ones.
    expect(report.totals).toEqual({
      runs: 4,
      tokensIn: 1000 + 500 + 300 + 40,
      tokensOut: 200 + 100 + 50 + 10,
      costUsd: expect.closeTo(0.0014 + 0.001 + 0.0005, 6),
      costRuns: 3,
    });
    // The headline is the days added up.
    const sum = (k: "runs" | "tokensIn" | "tokensOut") =>
      report.days.reduce((a: number, d: Record<string, number>) => a + d[k]!, 0);
    expect(sum("runs")).toBe(report.totals.runs);
    expect(sum("tokensIn")).toBe(report.totals.tokensIn);
    expect(report.days).toHaveLength(3);
    expect(report.deployments).toHaveLength(1);
    expect(report.deployments[0]).toMatchObject({ specId, runs: 4 });
    expect(report.limits.monthlyRuns.limit).toBe(50);
    expect(report.limits.monthlyRuns.used).toBeGreaterThanOrEqual(1);
    expect(report.limits.concurrentRuns.limit).toBe(0);
  }, 30_000);

  it("shows only this workspace's usage", async () => {
    const a = await newUserWithWorkspace();
    const b = await newUserWithWorkspace();
    await runSpec(a.cookie, "priced");
    const res = await app.inject({
      method: "GET",
      url: "/api/usage",
      headers: { cookie: b.cookie },
    });
    expect(res.json().totals).toMatchObject({ runs: 0, tokensIn: 0, costUsd: null });
    expect(res.json().deployments).toEqual([]);
  }, 30_000);
});
