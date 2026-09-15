import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createServer } from "../../../src/server.js";
import { workspaces } from "../../../src/db/schema.js";
import { decryptSecret } from "../../../src/crypto/envelope.js";

// KAN-1229 (ADR-0016): the masked BYOK key-management API (src/routes/byok.ts)
// exercised end to end through the server's Fastify inject() against a real
// Postgres -- proving keys are stored encrypted (never plaintext), only ever
// returned masked, and isolated per workspace by RLS. Skips without
// DATABASE_URL; runs in CI against the non-superuser role (KAN-1388). Local
// setup mirrors the sibling suites (see routes/specs.test.ts's header).

const DATABASE_URL = process.env["DATABASE_URL"];
const ROOT_KEY_B64 = randomBytes(32).toString("base64");

describe.skipIf(!DATABASE_URL)("BYOK key-management routes against a real Postgres", () => {
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

    app = createServer({ db });
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
    return `byok-${randomUUID()}@example.com`;
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

  function putKey(cookie: string, provider: string, key: string) {
    return app.inject({
      method: "PUT",
      url: `/api/byok/${provider}`,
      headers: { cookie },
      payload: { key },
    });
  }

  /** Reads the raw stored ciphertext for a workspace's provider via scoped raw SQL (byok_keys has RLS). */
  async function rawCiphertext(workspaceId: string, provider: string): Promise<string | undefined> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      const { rows } = await client.query<{ ciphertext: string }>(
        `SELECT ciphertext FROM byok_keys WHERE workspace_id = $1 AND provider = $2`,
        [workspaceId, provider],
      );
      await client.query("COMMIT");
      return rows[0]?.ciphertext;
    } finally {
      client.release();
    }
  }

  it("has RLS enabled AND forced on byok_keys (not merely enabled)", async () => {
    // Structural guarantee behind the cross-tenant test below: without FORCE,
    // the table-owning app role would silently bypass the policy (see
    // 0001_enable_row_level_security.sql). Mirrors workspace-scope.test.ts's
    // own check for the other tenant tables.
    const { rows } = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname = 'byok_keys' AND relkind = 'r'`,
    );
    expect(rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/byok" });
    expect(response.statusCode).toBe(401);
  });

  it("stores a key encrypted, returns only a mask, and never echoes the plaintext or ciphertext", async () => {
    const { cookie, workspaceId } = await newUserWithWorkspace();
    const secret = "sk-proj-supersecretvalue-9f8e7d";

    const put = await putKey(cookie, "openai", secret);
    expect(put.statusCode).toBe(200);
    // secret ends in "...9f8e7d" -> last four characters are "8e7d".
    expect(put.json()).toEqual({ success: true, provider: "openai", lastFour: "8e7d" });
    // The response body carries neither the plaintext nor the stored ciphertext.
    expect(put.body).not.toContain("supersecret");

    // What actually landed at rest is ciphertext, not the plaintext -- and it
    // decrypts back to the original only with the root key.
    const stored = await rawCiphertext(workspaceId, "openai");
    expect(stored).toBeDefined();
    expect(stored).not.toContain("supersecret");
    expect(decryptSecret(stored!, Buffer.from(ROOT_KEY_B64, "base64"))).toBe(secret);

    // The list route shows the provider masked, and no ciphertext field at all.
    const list = await app.inject({ method: "GET", url: "/api/byok", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().keys).toHaveLength(1);
    expect(list.json().keys[0]).toMatchObject({ provider: "openai", lastFour: "8e7d" });
    expect(list.body).not.toContain("supersecret");
    expect(list.body).not.toContain("ciphertext");
  });

  it("replaces an existing provider key in place (one row, new mask)", async () => {
    const { cookie, workspaceId } = await newUserWithWorkspace();
    await putKey(cookie, "anthropic", "sk-ant-first-0000");
    const replaced = await putKey(cookie, "anthropic", "sk-ant-second-9999");
    expect(replaced.json().lastFour).toBe("9999");

    const list = await app.inject({ method: "GET", url: "/api/byok", headers: { cookie } });
    expect(list.json().keys).toEqual([
      expect.objectContaining({ provider: "anthropic", lastFour: "9999" }),
    ]);
    expect(
      decryptSecret(
        (await rawCiphertext(workspaceId, "anthropic"))!,
        Buffer.from(ROOT_KEY_B64, "base64"),
      ),
    ).toBe("sk-ant-second-9999");
  });

  it("deletes a key, then reports 404 on a second delete", async () => {
    const { cookie } = await newUserWithWorkspace();
    await putKey(cookie, "openai", "sk-to-delete-1234");

    const del = await app.inject({
      method: "DELETE",
      url: "/api/byok/openai",
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);

    const empty = await app.inject({ method: "GET", url: "/api/byok", headers: { cookie } });
    expect(empty.json().keys).toEqual([]);

    const again = await app.inject({
      method: "DELETE",
      url: "/api/byok/openai",
      headers: { cookie },
    });
    expect(again.statusCode).toBe(404);
  });

  it("validates the provider slug and a non-empty key", async () => {
    const { cookie } = await newUserWithWorkspace();
    expect((await putKey(cookie, "Not_A_Slug!", "sk-x")).statusCode).toBe(400);
    expect((await putKey(cookie, "openai", "")).statusCode).toBe(400);
  });

  it("fails visibly (500) when the server has no BYOK root key configured, without storing anything", async () => {
    const { cookie, workspaceId } = await newUserWithWorkspace();
    const previous = process.env["BYOK_ROOT_KEY"];
    delete process.env["BYOK_ROOT_KEY"];
    try {
      const response = await putKey(cookie, "openai", "sk-should-not-store");
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("should-not-store");
    } finally {
      process.env["BYOK_ROOT_KEY"] = previous;
    }
    expect(await rawCiphertext(workspaceId, "openai")).toBeUndefined();
  });

  it("isolates keys per workspace: one workspace cannot see or delete another's key", async () => {
    const a = await newUserWithWorkspace();
    const b = await newUserWithWorkspace();
    await putKey(a.cookie, "openai", "sk-a-only-4242");

    const listB = await app.inject({
      method: "GET",
      url: "/api/byok",
      headers: { cookie: b.cookie },
    });
    expect(listB.json().keys).toEqual([]);

    const delB = await app.inject({
      method: "DELETE",
      url: "/api/byok/openai",
      headers: { cookie: b.cookie },
    });
    expect(delB.statusCode).toBe(404);

    // A's key is untouched.
    const listA = await app.inject({
      method: "GET",
      url: "/api/byok",
      headers: { cookie: a.cookie },
    });
    expect(listA.json().keys).toEqual([
      expect.objectContaining({ provider: "openai", lastFour: "4242" }),
    ]);
  });
});
