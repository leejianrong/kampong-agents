import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createServer } from "../../../src/server.js";
import { workspaces } from "../../../src/db/schema.js";

// KAN-1227 (ADR-0014/ADR-0015/ADR-0019): the authenticated, workspace-scoped
// spec-CRUD routes (src/routes/specs.ts) exercised end to end through the
// server's own Fastify `inject()` against a real Postgres -- Better Auth
// sign-up/org-create for a real session cookie, then the /api/specs surface
// under it, with RLS doing the tenant isolation. Follows the same
// skip-without-DATABASE_URL pattern as the sibling db/* integration suites.
//
// To run this locally (mirrors those suites' instructions, but note the
// non-superuser role KAN-1388/CI also uses -- a superuser bypasses FORCE RLS
// and makes the isolation assertions below vacuous):
//   docker run --rm -d --name kampong-pg-test -p 15433:5432 \
//     -e POSTGRES_PASSWORD=postgres postgres:18
//   docker exec kampong-pg-test psql -U postgres \
//     -c "CREATE ROLE app_test LOGIN PASSWORD 'app_test' NOSUPERUSER NOBYPASSRLS;" \
//     -c "CREATE DATABASE kampong_test OWNER app_test;"
//   DATABASE_URL=postgres://app_test:app_test@localhost:15433/kampong_test \
//     npm run test:integration --workspace=packages/server
//   docker stop kampong-pg-test

const DATABASE_URL = process.env["DATABASE_URL"];

const VALID_SPEC = `version: "1.0"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  workflow:
    - step: greet
      action: say_hello
`;

describe.skipIf(!DATABASE_URL)("Authenticated spec-CRUD routes against a real Postgres", () => {
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
    return `spec-routes-${randomUUID()}@example.com`;
  }

  /**
   * Signs up a fresh user and creates a workspace through Better Auth's own
   * endpoints -- org-create sets the new workspace active on the session, so
   * the returned cookie is already scoped to it for the /api/specs routes.
   */
  async function newUserWithWorkspace(): Promise<{
    cookie: string;
    userId: string;
    workspaceId: string;
  }> {
    const signUp = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: uniqueEmail(), password: "correct-horse-battery-staple", name: "T" },
    });
    const setCookie = signUp.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!cookieHeader) throw new Error("sign-up did not issue a session cookie");
    const cookie = cookieHeader.split(";")[0]!;
    const userId = signUp.json().user.id;

    const create = await app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      headers: { cookie, origin: "http://localhost:3000" },
      payload: { name: "WS", slug: `ws-${randomUUID()}` },
    });
    expect(create.statusCode).toBe(200);
    const workspaceId = create.json().id;
    createdWorkspaceIds.push(workspaceId);
    return { cookie, userId, workspaceId };
  }

  async function createSpec(cookie: string, name: string, source = VALID_SPEC) {
    return app.inject({
      method: "POST",
      url: "/api/specs",
      headers: { cookie },
      payload: { name, source },
    });
  }

  describe("authentication gate", () => {
    it("rejects an unauthenticated request with 401, not a silent empty result", async () => {
      const response = await app.inject({ method: "GET", url: "/api/specs" });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ success: false, error: expect.stringMatching(/auth/i) });
    });

    it("rejects a session with no active workspace with 403", async () => {
      // Sign up but do NOT create/select a workspace -- activeOrganizationId
      // stays null, so there is nothing to scope to.
      const signUp = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        payload: { email: uniqueEmail(), password: "correct-horse-battery-staple", name: "T" },
      });
      const setCookie = signUp.headers["set-cookie"];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;

      const response = await app.inject({ method: "GET", url: "/api/specs", headers: { cookie } });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatch(/active workspace/i);
    });
  });

  describe("CRUD within a workspace", () => {
    it("creates, lists, reads, and patches a spec", async () => {
      const { cookie } = await newUserWithWorkspace();

      const created = await createSpec(cookie, "greeter");
      expect(created.statusCode).toBe(201);
      const specId = created.json().id;
      expect(specId).toMatch(/^[0-9a-f]{8}-/i);

      const list = await app.inject({ method: "GET", url: "/api/specs", headers: { cookie } });
      expect(list.statusCode).toBe(200);
      expect(list.json().specs).toEqual([{ id: specId, name: "greeter" }]);

      const read = await app.inject({
        method: "GET",
        url: `/api/specs/${specId}`,
        headers: { cookie },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().success).toBe(true);
      expect(read.json().source).toBe(VALID_SPEC);

      const patched = await app.inject({
        method: "PUT",
        url: `/api/specs/${specId}`,
        headers: { cookie },
        payload: { ops: [{ op: "set", path: ["agent", "goal"], value: "Greet everyone." }] },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().success).toBe(true);

      const reread = await app.inject({
        method: "GET",
        url: `/api/specs/${specId}`,
        headers: { cookie },
      });
      expect(reread.json().source).toContain("Greet everyone.");
    });

    it("rejects creating a spec with invalid YAML source (422), persisting nothing", async () => {
      const { cookie } = await newUserWithWorkspace();
      const bad = await createSpec(cookie, "broken", "version: 1.0\nagent: {}\n");
      expect(bad.statusCode).toBe(422);
      expect(bad.json().success).toBe(false);
      expect(Array.isArray(bad.json().errors)).toBe(true);

      const list = await app.inject({ method: "GET", url: "/api/specs", headers: { cookie } });
      expect(list.json().specs).toEqual([]);
    });

    it("rejects an invalid patch with 422 without bumping the stored spec", async () => {
      const { cookie } = await newUserWithWorkspace();
      const specId = (await createSpec(cookie, "greeter")).json().id;

      const bad = await app.inject({
        method: "PUT",
        url: `/api/specs/${specId}`,
        headers: { cookie },
        payload: { ops: [{ op: "set", path: ["agent", "id"], value: "" }] },
      });
      expect(bad.statusCode).toBe(422);

      const read = await app.inject({
        method: "GET",
        url: `/api/specs/${specId}`,
        headers: { cookie },
      });
      expect(read.json().source).toBe(VALID_SPEC);
    });

    it("returns 404 for a spec id that does not exist in the workspace", async () => {
      const { cookie } = await newUserWithWorkspace();
      const response = await app.inject({
        method: "GET",
        url: `/api/specs/${randomUUID()}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe("cross-tenant isolation (RLS)", () => {
    it("one workspace cannot read, list, or patch another workspace's spec", async () => {
      const a = await newUserWithWorkspace();
      const b = await newUserWithWorkspace();

      const specId = (await createSpec(a.cookie, "a-secret")).json().id;

      // B lists: A's spec is invisible.
      const listB = await app.inject({
        method: "GET",
        url: "/api/specs",
        headers: { cookie: b.cookie },
      });
      expect(listB.json().specs).toEqual([]);

      // B reads A's spec id directly: RLS hides it -> 404, not 200.
      const readB = await app.inject({
        method: "GET",
        url: `/api/specs/${specId}`,
        headers: { cookie: b.cookie },
      });
      expect(readB.statusCode).toBe(404);

      // B patches A's spec id: also 404, and A's spec is unchanged.
      const patchB = await app.inject({
        method: "PUT",
        url: `/api/specs/${specId}`,
        headers: { cookie: b.cookie },
        payload: { ops: [{ op: "set", path: ["agent", "goal"], value: "hijacked" }] },
      });
      expect(patchB.statusCode).toBe(404);

      const readA = await app.inject({
        method: "GET",
        url: `/api/specs/${specId}`,
        headers: { cookie: a.cookie },
      });
      expect(readA.json().source).toBe(VALID_SPEC);
    });

    it("a session whose active workspace is one the user does not belong to is rejected (403), even though RLS alone keys only on the id", async () => {
      // ADR-0019's load-bearing check: RLS on specs keys purely on
      // `app.workspace_id`, NOT on membership. Forge exactly that gap by
      // pointing user A's session at workspace B (which A is not a member of)
      // directly in the session row -- the app-layer membership check in
      // resolveWorkspaceContext must still refuse it.
      const a = await newUserWithWorkspace();
      const b = await newUserWithWorkspace();
      const specId = (await createSpec(b.cookie, "b-secret")).json().id;

      await pool.query(`UPDATE "session" SET active_organization_id = $1 WHERE user_id = $2`, [
        b.workspaceId,
        a.userId,
      ]);

      const forged = await app.inject({
        method: "GET",
        url: `/api/specs/${specId}`,
        headers: { cookie: a.cookie },
      });
      expect(forged.statusCode).toBe(403);
      expect(forged.json().error).toMatch(/not a member/i);
    });
  });
});
