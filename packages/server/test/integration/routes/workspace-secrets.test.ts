import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { ModelClient, RunState } from "@kampong/engine";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createServer } from "../../../src/server.js";
import { workspaces } from "../../../src/db/schema.js";
import { decryptSecret } from "../../../src/crypto/envelope.js";
import { resolveWorkspaceSecrets } from "../../../src/secrets/resolve.js";
// @ts-expect-error plain .mjs fakes shared with the e2e suite; no type declarations
import { fakeFetch, requests } from "../../../../../e2e/fixtures/market-etl-network.mjs";
// @ts-expect-error plain .mjs fake model shared with the e2e suite; no type declarations
import { fakeModel } from "../../../../../e2e/fixtures/market-etl-model.mjs";

// KAM-81 (ADR-0016, ADR-0022): a hosted workflow's connectors read the workspace's own stored credentials. Proves,
// against a real Postgres: the management routes store a secret encrypted and only ever return a mask; RLS keeps
// one workspace's secrets from another (the route AND the resolver); and a hosted run, with an EMPTY server
// environment, uses the stored values, and fails visibly naming the variable when one is not stored. Skips without
// DATABASE_URL; runs in CI against the non-superuser role (KAN-1388).

const DATABASE_URL = process.env["DATABASE_URL"];
const ROOT_KEY_B64 = randomBytes(32).toString("base64");

const TEMPLATE = readFileSync(
  fileURLToPath(new URL("../../../../cli/templates/market-etl/agent.yaml", import.meta.url)),
  "utf8",
);
const SECRETS = {
  ALPHAVANTAGE_API_KEY: "vault-alpha-vantage-key",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_KEY: "vault-supabase-key",
  SLACK_BOT_TOKEN: "xoxb-vault-slack-token",
};

describe.skipIf(!DATABASE_URL)("Workspace tool secrets against a real Postgres (KAM-81)", () => {
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
    process.env["BYOK_ROOT_KEY"] = ROOT_KEY_B64;
    delete process.env["GITHUB_CLIENT_ID"];
    delete process.env["GITHUB_CLIENT_SECRET"];
    // No `env`: the run's own environment starts EMPTY, so anything a tool reads must come from the vault.
    app = createServer({
      db,
      run: { createModel: () => fakeModel as ModelClient, fetchImpl: fakeFetch },
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
        email: `secrets-${randomUUID()}@example.com`,
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

  const putSecret = (cookie: string, name: string, value: string) =>
    app.inject({
      method: "PUT",
      url: `/api/secrets/${name}`,
      headers: { cookie },
      payload: { value },
    });

  async function rawCiphertext(workspaceId: string, name: string): Promise<string | undefined> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      const { rows } = await client.query<{ ciphertext: string }>(
        `SELECT ciphertext FROM workspace_secrets WHERE workspace_id = $1 AND name = $2`,
        [workspaceId, name],
      );
      await client.query("COMMIT");
      return rows[0]?.ciphertext;
    } finally {
      client.release();
    }
  }

  async function hostedRun(cookie: string): Promise<RunState> {
    const created = await app.inject({
      method: "POST",
      url: "/api/specs",
      headers: { cookie },
      payload: { name: "etl", source: TEMPLATE },
    });
    expect(created.statusCode, created.body).toBe(201);
    const start = await app.inject({
      method: "POST",
      url: `/api/specs/${created.json().id}/runs`,
      headers: { cookie },
      payload: { input: "", vars: { symbols: ["AAPL", "NVDA"], threshold: 50 } },
    });
    expect(start.statusCode, start.body).toBe(201);
    const runId = start.json().id;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const res = await app.inject({
        method: "GET",
        url: `/api/runs/${runId}`,
        headers: { cookie },
      });
      const state = res.json().state as RunState;
      if (state.status !== "running") return state;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("run did not finish in time");
  }

  it("has RLS enabled AND forced on workspace_secrets", async () => {
    const { rows } = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname = 'workspace_secrets' AND relkind = 'r'`,
    );
    expect(rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("rejects an unauthenticated request with 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/secrets" })).statusCode).toBe(401);
  });

  it("stores a secret encrypted, returns only a mask, never the value or ciphertext", async () => {
    const { cookie, workspaceId } = await newUserWithWorkspace();
    const put = await putSecret(cookie, "SLACK_BOT_TOKEN", "xoxb-supersecret-value-1a2b");
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ success: true, name: "SLACK_BOT_TOKEN", lastFour: "1a2b" });
    expect(put.body).not.toContain("supersecret");

    const stored = await rawCiphertext(workspaceId, "SLACK_BOT_TOKEN");
    expect(stored).toBeDefined();
    expect(stored).not.toContain("supersecret");
    expect(decryptSecret(stored!, Buffer.from(ROOT_KEY_B64, "base64"))).toBe(
      "xoxb-supersecret-value-1a2b",
    );

    const list = await app.inject({ method: "GET", url: "/api/secrets", headers: { cookie } });
    expect(list.json().secrets).toEqual([
      expect.objectContaining({ name: "SLACK_BOT_TOKEN", lastFour: "1a2b" }),
    ]);
    expect(list.body).not.toContain("supersecret");
    expect(list.body).not.toContain("ciphertext");
  });

  it("replaces a secret in place, deletes it, and 404s a second delete", async () => {
    const { cookie } = await newUserWithWorkspace();
    await putSecret(cookie, "SUPABASE_KEY", "first-0000");
    expect((await putSecret(cookie, "SUPABASE_KEY", "second-9999")).json().lastFour).toBe("9999");
    const list = await app.inject({ method: "GET", url: "/api/secrets", headers: { cookie } });
    expect(list.json().secrets).toHaveLength(1);

    const del = () =>
      app.inject({ method: "DELETE", url: "/api/secrets/SUPABASE_KEY", headers: { cookie } });
    expect((await del()).statusCode).toBe(200);
    expect((await del()).statusCode).toBe(404);
  });

  it("validates the name (an environment-variable name) and a non-empty value", async () => {
    const { cookie } = await newUserWithWorkspace();
    expect((await putSecret(cookie, "lower_case", "x")).statusCode).toBe(400);
    expect((await putSecret(cookie, "1STARTS_WITH_DIGIT", "x")).statusCode).toBe(400);
    expect((await putSecret(cookie, "SLACK_BOT_TOKEN", "")).statusCode).toBe(400);
  });

  it("isolates secrets per workspace, in the route and in the resolver", async () => {
    const a = await newUserWithWorkspace();
    const b = await newUserWithWorkspace();
    await putSecret(a.cookie, "SLACK_BOT_TOKEN", "xoxb-a-only-4242");

    const listB = await app.inject({
      method: "GET",
      url: "/api/secrets",
      headers: { cookie: b.cookie },
    });
    expect(listB.json().secrets).toEqual([]);
    const delB = await app.inject({
      method: "DELETE",
      url: "/api/secrets/SLACK_BOT_TOKEN",
      headers: { cookie: b.cookie },
    });
    expect(delB.statusCode).toBe(404);

    const names = ["SLACK_BOT_TOKEN"];
    expect(await resolveWorkspaceSecrets({ db, workspaceId: b.workspaceId, names })).toEqual({});
    expect(await resolveWorkspaceSecrets({ db, workspaceId: a.workspaceId, names })).toEqual({
      SLACK_BOT_TOKEN: "xoxb-a-only-4242",
    });
  });

  it("resolves only the names asked for, and nothing at all for no names", async () => {
    const { cookie, workspaceId } = await newUserWithWorkspace();
    await putSecret(cookie, "SLACK_BOT_TOKEN", "xoxb-one-1111");
    await putSecret(cookie, "SUPABASE_KEY", "two-2222");
    expect(
      await resolveWorkspaceSecrets({ db, workspaceId, names: ["SLACK_BOT_TOKEN", "NOT_STORED"] }),
    ).toEqual({ SLACK_BOT_TOKEN: "xoxb-one-1111" });
    expect(await resolveWorkspaceSecrets({ db, workspaceId, names: [] })).toEqual({});
  });

  it("a hosted run with an empty server environment uses the workspace's stored secrets", async () => {
    const { cookie } = await newUserWithWorkspace();
    for (const [name, value] of Object.entries(SECRETS)) {
      expect((await putSecret(cookie, name, value)).statusCode).toBe(200);
    }
    requests.length = 0;
    const state = await hostedRun(cookie);
    expect(state.status, state.error).toBe("completed");
    expect((requests as { service: string }[]).some((r) => r.service === "supabase")).toBe(true);
  }, 30_000);

  it("a hosted run without the secrets fails visibly, and never uses another workspace's", async () => {
    const owner = await newUserWithWorkspace();
    for (const [name, value] of Object.entries(SECRETS)) await putSecret(owner.cookie, name, value);
    const other = await newUserWithWorkspace();

    requests.length = 0;
    const state = await hostedRun(other.cookie);
    expect(JSON.stringify(state)).toMatch(
      /ALPHAVANTAGE_API_KEY|SUPABASE_KEY|SUPABASE_URL|SLACK_BOT_TOKEN/,
    );
    expect(JSON.stringify(requests)).not.toContain("vault-alpha-vantage-key");
  }, 30_000);
});
