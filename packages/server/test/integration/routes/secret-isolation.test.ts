import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import type { ModelClient, RunState } from "@kampong/engine";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createServer } from "../../../src/server.js";
import { workspaces } from "../../../src/db/schema.js";
import { withWorkspaceScope } from "../../../src/db/workspace-scope.js";
import { resolveWorkspaceSecrets } from "../../../src/secrets/resolve.js";
// @ts-expect-error plain .mjs fakes shared with the e2e suite; no type declarations
import { fakeFetch, requests } from "../../../../../e2e/fixtures/market-etl-network.mjs";

// KAM-85: the adversarial counterpart for connector credentials, in the shape of db/rls-adversarial.test.ts.
// Workspace A stores a connector token. Workspace B then tries to reach it by every route we can think of: a query
// that names A, a UNION, an update, an insert stamped with A's id, a blank or hostile scope, a request that carries
// A's id in a header, the query string or the body, the resolver asked for A's names, and finally B's own
// webhook-triggered run of a workflow that reads that token. Nothing may come back, and nothing may be sent to the
// connector. A positive control shows A can still use its own token, so the checks are not vacuous. Skips without
// DATABASE_URL; runs in CI against the non-superuser role.

const DATABASE_URL = process.env["DATABASE_URL"];
const ROOT_KEY_B64 = randomBytes(32).toString("base64");
const A_TOKEN = "xoxb-workspace-a-only-7f3c9e1d";

const model: ModelClient = {
  async generateText() {
    return "ok";
  },
  async generateStructured<T>() {
    return { result: {}, confidence: 1 } as T;
  },
};

const SPEC = `version: "1.1"
agent:
  id: slack-hook
  name: "Slack hook"
  role: "r"
  goal: "g"
  trigger:
    type: webhook
    preset: alertmanager
    auth: { secret_env: HOOK_TOKEN }
  tools:
    - name: post_to_slack
      action: component
      use: kampong/slack@1.0.0
      op: post_message
      with:
        channel: "#ops"
        text: "hello"
  workflow:
    - step: post
      action: post_to_slack
`;

describe.skipIf(!DATABASE_URL)("Connector secrets across tenants, adversarially (KAM-85)", () => {
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
    app = createServer({ db, run: { createModel: () => model, fetchImpl: fakeFetch } });
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
        email: `iso-${randomUUID()}@example.com`,
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

  /** A workspace A that holds the token, and a workspace B that does not. */
  async function pair() {
    const a = await newUserWithWorkspace();
    const b = await newUserWithWorkspace();
    const put = await app.inject({
      method: "PUT",
      url: "/api/secrets/SLACK_BOT_TOKEN",
      headers: { cookie: a.cookie },
      payload: { value: A_TOKEN },
    });
    expect(put.statusCode, put.body).toBe(200);
    return { a, b };
  }

  /** The rows a statement returns, or "error" when the database refused it: either is a pass for an attacker's query. */
  async function attempt(workspaceId: string, run: (tx: never) => Promise<unknown>) {
    try {
      return await withWorkspaceScope(db, workspaceId, run as never);
    } catch {
      return "error";
    }
  }

  const rowsOf = (result: unknown): unknown[] =>
    Array.isArray(result) ? result : ((result as { rows?: unknown[] } | undefined)?.rows ?? []);

  it("runs as a role that cannot bypass row-level security (else every check below is vacuous)", async () => {
    const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("positive control: A can read its own token through its own scope", async () => {
    const { a } = await pair();
    expect(
      await resolveWorkspaceSecrets({
        db,
        workspaceId: a.workspaceId,
        names: ["SLACK_BOT_TOKEN"],
      }),
    ).toEqual({ SLACK_BOT_TOKEN: A_TOKEN });
  });

  it("B's scope cannot read A's rows by naming A, by UNION, or with no WHERE at all", async () => {
    const { a, b } = await pair();
    const named = await attempt(b.workspaceId, (tx: never) =>
      (tx as DbClient).execute(
        sql`SELECT name, ciphertext FROM workspace_secrets WHERE workspace_id = ${a.workspaceId}`,
      ),
    );
    const union = await attempt(b.workspaceId, (tx: never) =>
      (tx as DbClient).execute(
        sql`SELECT name, ciphertext FROM workspace_secrets WHERE workspace_id = ${b.workspaceId}
            UNION ALL SELECT name, ciphertext FROM workspace_secrets WHERE workspace_id = ${a.workspaceId}`,
      ),
    );
    const bare = await attempt(b.workspaceId, (tx: never) =>
      (tx as DbClient).execute(sql`SELECT name, ciphertext FROM workspace_secrets`),
    );
    for (const result of [named, union, bare]) expect(rowsOf(result)).toEqual([]);
  });

  it("B's scope cannot change, delete or plant a row in A's vault", async () => {
    const { a, b } = await pair();
    const updated = await attempt(b.workspaceId, (tx: never) =>
      (tx as DbClient).execute(
        sql`UPDATE workspace_secrets SET ciphertext = 'x' WHERE workspace_id = ${a.workspaceId} RETURNING name`,
      ),
    );
    const deleted = await attempt(b.workspaceId, (tx: never) =>
      (tx as DbClient).execute(
        sql`DELETE FROM workspace_secrets WHERE workspace_id = ${a.workspaceId} RETURNING name`,
      ),
    );
    const planted = await attempt(b.workspaceId, (tx: never) =>
      (tx as DbClient).execute(
        sql`INSERT INTO workspace_secrets (workspace_id, name, ciphertext, last_four)
            VALUES (${a.workspaceId}, 'PLANTED', 'x', '0000')`,
      ),
    );
    expect(rowsOf(updated)).toEqual([]);
    expect(rowsOf(deleted)).toEqual([]);
    expect(planted).toBe("error");
    // And A's token is untouched.
    expect(
      await resolveWorkspaceSecrets({ db, workspaceId: a.workspaceId, names: ["SLACK_BOT_TOKEN"] }),
    ).toEqual({ SLACK_BOT_TOKEN: A_TOKEN });
  });

  it("a malformed, blank or injected scope reads nothing and never widens to A", async () => {
    const { a } = await pair();
    for (const hostile of [
      "",
      "not-a-uuid",
      `${a.workspaceId}' OR '1'='1`,
      `${a.workspaceId.toUpperCase()}\u0000`,
      "00000000-0000-0000-0000-000000000000",
    ]) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [hostile]);
        let rows: unknown[] = [];
        try {
          ({ rows } = await client.query("SELECT name FROM workspace_secrets"));
        } catch {
          // The policy refusing to cast it is as good as returning nothing.
        }
        await client.query("ROLLBACK");
        expect(rows, `scope ${JSON.stringify(hostile)}`).toEqual([]);
      } finally {
        client.release();
      }
    }
    // The scoped helper refuses a non-UUID before it reaches the database.
    await expect(
      resolveWorkspaceSecrets({ db, workspaceId: "x' OR '1'='1", names: ["SLACK_BOT_TOKEN"] }),
    ).rejects.toThrow();
  });

  it("the resolver, asked by B for A's names (or for SQL-shaped ones), returns nothing", async () => {
    const { b } = await pair();
    expect(
      await resolveWorkspaceSecrets({
        db,
        workspaceId: b.workspaceId,
        names: ["SLACK_BOT_TOKEN", "X' OR '1'='1", "slack_bot_token"],
      }),
    ).toEqual({});
  });

  it("B's requests that carry A's id in a header, the query or the body still see only B's vault", async () => {
    const { a, b } = await pair();
    const list = await app.inject({
      method: "GET",
      url: `/api/secrets?workspaceId=${a.workspaceId}&workspace_id=${a.workspaceId}`,
      headers: {
        cookie: b.cookie,
        "x-workspace-id": a.workspaceId,
        "x-active-organization-id": a.workspaceId,
      },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().secrets).toEqual([]);
    expect(list.body).not.toContain(A_TOKEN);

    const put = await app.inject({
      method: "PUT",
      url: "/api/secrets/PLANTED",
      headers: { cookie: b.cookie, "x-workspace-id": a.workspaceId },
      payload: { value: "x", workspaceId: a.workspaceId, workspace_id: a.workspaceId },
    });
    expect(put.statusCode).toBe(200);
    // It landed in B, not in A.
    const listA = await app.inject({
      method: "GET",
      url: "/api/secrets",
      headers: { cookie: a.cookie },
    });
    expect((listA.json().secrets as { name: string }[]).map((s) => s.name)).toEqual([
      "SLACK_BOT_TOKEN",
    ]);
  });

  async function deployAndFire(cookie: string) {
    const created = await app.inject({
      method: "POST",
      url: "/api/specs",
      headers: { cookie },
      payload: { name: "hook", source: SPEC },
    });
    expect(created.statusCode, created.body).toBe(201);
    const deployed = await app.inject({
      method: "PUT",
      url: `/api/specs/${created.json().id}/deployment`,
      headers: { cookie },
    });
    expect(deployed.statusCode, deployed.body).toBe(200);
    const hook = deployed.json() as { webhookPath: string; webhookSecret: string };
    const fired = await app.inject({
      method: "POST",
      url: hook.webhookPath,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hook.webhookSecret}`,
      },
      payload: JSON.stringify({ status: "firing" }),
    });
    expect(fired.statusCode, fired.body).toBe(201);
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/api/runs/${fired.json().id}`,
        headers: { cookie },
      });
      const state = res.json().state as RunState;
      if (state.status !== "running") return state;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("run did not finish");
  }

  it("B's webhook-triggered run of a workflow that reads the token fails visibly and sends nothing", async () => {
    const { b } = await pair();
    requests.length = 0;
    const state = await deployAndFire(b.cookie);
    expect(JSON.stringify(state)).toMatch(/SLACK_BOT_TOKEN/);
    expect(JSON.stringify(state)).not.toContain(A_TOKEN);
    expect(JSON.stringify(requests)).not.toContain(A_TOKEN);
    expect((requests as { service: string }[]).some((r) => r.service === "slack")).toBe(false);
  }, 30_000);

  it("positive control: A's own webhook-triggered run does use A's token", async () => {
    const { a } = await pair();
    requests.length = 0;
    const state = await deployAndFire(a.cookie);
    expect(state.status, state.error).toBe("completed");
    expect((requests as { service: string }[]).some((r) => r.service === "slack")).toBe(true);
  }, 30_000);
});
