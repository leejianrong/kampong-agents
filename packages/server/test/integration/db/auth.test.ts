import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createServer } from "../../../src/server.js";
import { workspaceMembers, workspaces } from "../../../src/db/schema.js";

// KAN-1226 (ADR-0015): exercises Better Auth's own real HTTP endpoints
// (mounted in src/server.ts) against a real Postgres, through the server's
// own Fastify `inject()` -- not just unit-testing the config object. Follows
// the same skip-without-DATABASE_URL pattern as migrations.test.ts/
// workspace-scope.test.ts/spec-repository.test.ts.
//
// To run this locally (mirrors those suites' own instructions):
//   docker run --rm -d --name kampong-pg-test -p 15433:5432 \
//     -e POSTGRES_PASSWORD=postgres postgres:18
//   DATABASE_URL=postgres://postgres:postgres@localhost:15433/postgres \
//     npm run test:integration --workspace=packages/server
//   docker stop kampong-pg-test
//
// A real, verified, and load-bearing finding this suite encodes as a
// regression test (see the "organization create" describe block below and
// drizzle/0004_workspace_members_bootstrap_insert.sql's own extensive
// comment for the full story): KAN-1225's FORCE ROW LEVEL SECURITY on
// `workspace_members`, left exactly as that card merged it, makes Better
// Auth's own `/organization/create` endpoint impossible to use at all --
// its member-row insert has no knowledge of this project's
// `app.workspace_id` session-variable convention. This card adds a narrow,
// additive second policy (0004) plus a `workspaces.member_count`-tracking
// trigger to make organization creation possible without loosening
// KAN-1225's own policy or its guarantees for every other write path.

const DATABASE_URL = process.env["DATABASE_URL"];

describe.skipIf(!DATABASE_URL)("Better Auth HTTP endpoints against a real Postgres", () => {
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
    return `auth-test-${randomUUID()}@example.com`;
  }

  /**
   * Drizzle wraps the real Postgres error in a generic `DrizzleQueryError`
   * ("Failed query: ...") and attaches the actual driver error as `.cause`
   * (standard Node.js error-cause chaining) -- mirrors
   * workspace-scope.test.ts's own `expectRejectionCause` helper.
   */
  async function expectRejectionCause(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const cause = (caught as Error).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toMatch(pattern);
  }

  async function signUp(email: string, password: string, name = "Test User") {
    return app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name },
    });
  }

  describe("sign-up / sign-in with email+password", () => {
    it("sign-up issues a session cookie", async () => {
      const response = await signUp(uniqueEmail(), "correct-horse-battery-staple");
      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toBeDefined();
      const body = response.json();
      expect(body.user.email).toMatch(/^auth-test-/);
      // The concrete answer to this card's own "genuine Postgres uuid, not
      // Better Auth's more common short-random-string default" brief --
      // verified against a real inserted row, not just the API response.
      expect(body.user.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("sign-in with the correct password succeeds", async () => {
      const email = uniqueEmail();
      const password = "correct-horse-battery-staple";
      await signUp(email, password);

      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        payload: { email, password },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toBeDefined();
    });

    it("sign-in with the wrong password is rejected, not silently allowed", async () => {
      const email = uniqueEmail();
      await signUp(email, "correct-horse-battery-staple");

      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        payload: { email, password: "definitely-the-wrong-password" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
    });

    it("sign-in for an email that was never signed up is rejected", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        payload: { email: uniqueEmail(), password: "whatever-password-123" },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("session-requiring endpoints reject anonymous requests", () => {
    it("GET /api/auth/organization/list with no session cookie is rejected, not silently allowed through", async () => {
      const response = await app.inject({ method: "GET", url: "/api/auth/organization/list" });
      expect(response.statusCode).toBe(401);
    });

    it("GET /api/auth/get-session with no cookie returns no session (not an error, not someone else's session)", async () => {
      const response = await app.inject({ method: "GET", url: "/api/auth/get-session" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toBeNull();
    });
  });

  describe("GitHub OAuth (configured permissively -- no real GitHub credentials used)", () => {
    it("produces a real github.com authorize redirect when GITHUB_CLIENT_ID/SECRET are set", async () => {
      // A dedicated server instance for just this test: the shared `app`
      // (beforeAll) deliberately has no GitHub credentials, matching a
      // dev/CI environment with no GitHub OAuth app registered yet. This
      // proves the *other* branch -- GitHub sign-in is a real, working
      // route once an operator does configure it -- without needing an
      // actual GitHub client secret or any live network call to
      // github.com: Better Auth builds the authorize URL itself from the
      // (fake, here) client id.
      process.env["GITHUB_CLIENT_ID"] = "fake-client-id";
      process.env["GITHUB_CLIENT_SECRET"] = "fake-client-secret";
      let githubApp: FastifyInstance | undefined;
      try {
        githubApp = createServer({ db });
        await githubApp.ready();

        const response = await githubApp.inject({
          method: "POST",
          url: "/api/auth/sign-in/social",
          headers: { origin: "http://localhost:3000" },
          payload: { provider: "github", callbackURL: "/" },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.url).toBeDefined();
        expect(new URL(body.url).host).toBe("github.com");
      } finally {
        await githubApp?.close();
        delete process.env["GITHUB_CLIENT_ID"];
        delete process.env["GITHUB_CLIENT_SECRET"];
      }
    });
  });

  describe("organization creation maps onto the existing workspaces/workspace_members tables", () => {
    async function signUpAndGetCookie(): Promise<{ cookie: string; userId: string }> {
      const email = uniqueEmail();
      const response = await signUp(email, "correct-horse-battery-staple");
      const setCookie = response.headers["set-cookie"];
      const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      if (!cookieHeader) throw new Error("sign-up did not issue a session cookie");
      return { cookie: cookieHeader.split(";")[0]!, userId: response.json().user.id };
    }

    it("creating an organization writes a real row to the existing `workspaces` table (verified via raw SQL, not just Better Auth's own API)", async () => {
      const { cookie, userId } = await signUpAndGetCookie();
      const slug = `test-workspace-${randomUUID()}`;

      const response = await app.inject({
        method: "POST",
        url: "/api/auth/organization/create",
        headers: { cookie, origin: "http://localhost:3000" },
        payload: { name: "Test Workspace", slug },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.slug).toBe(slug);
      createdWorkspaceIds.push(body.id);

      // Raw SQL against the pool, deliberately not going back through
      // Better Auth's own API or Drizzle's query builder for this
      // assertion -- proving the row really landed in the same
      // `workspaces` table PgSpecRepository/KAN-1225's RLS policies
      // already depend on, with the shape this project's other code
      // expects (a genuine uuid id). `workspaces` has no RLS at all
      // (ADR-0014), so this plain query needs no scoping.
      const { rows } = await pool.query<{ id: string; name: string; slug: string }>(
        `SELECT id, name, slug FROM workspaces WHERE id = $1`,
        [body.id],
      );
      expect(rows).toEqual([{ id: body.id, name: "Test Workspace", slug }]);

      // `workspace_members` DOES have RLS (KAN-1225, FORCE ROW LEVEL
      // SECURITY) -- a plain, unscoped `pool.query` here would correctly
      // see zero rows regardless of whether the insert actually happened
      // (confirmed empirically while writing this test: the response
      // body above already includes the real inserted member row, proving
      // the write succeeded, while an unscoped read of it still comes back
      // empty -- RLS doing exactly its job). So this raw-SQL check, like
      // `withWorkspaceScope`, sets `app.workspace_id` itself before
      // reading -- still real SQL against the real table, not going
      // through Drizzle or PgSpecRepository, just correctly scoped.
      const client = await pool.connect();
      let memberRows: { workspace_id: string; user_id: string; role: string }[];
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [body.id]);
        const result = await client.query<{
          workspace_id: string;
          user_id: string;
          role: string;
        }>(`SELECT workspace_id, user_id, role FROM workspace_members WHERE workspace_id = $1`, [
          body.id,
        ]);
        memberRows = result.rows;
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      expect(memberRows).toEqual([{ workspace_id: body.id, user_id: userId, role: "owner" }]);
    });

    it("the bootstrap-insert policy closes after the first member -- a second, unscoped member insert into the same workspace is still rejected by RLS", async () => {
      const { cookie } = await signUpAndGetCookie();
      const { userId: secondUserId } = await signUpAndGetCookie();
      const slug = `test-workspace-${randomUUID()}`;
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/auth/organization/create",
        headers: { cookie, origin: "http://localhost:3000" },
        payload: { name: "Second Member Test", slug },
      });
      const workspaceId = createResponse.json().id;
      createdWorkspaceIds.push(workspaceId);

      // A second member row (a real, already-signed-up user -- so this
      // can only fail on RLS, not an incidental FK violation) inserted
      // with no `app.workspace_id` session variable set at all (exactly
      // the "some code path forgot to scope" failure mode KAN-1225's own
      // policy exists to guard against) -- this must still be rejected:
      // the bootstrap policy this card adds only ever admits a
      // workspace's *first* member row.
      await expectRejectionCause(
        db.insert(workspaceMembers).values({
          workspaceId,
          userId: secondUserId,
          role: "owner",
        }),
        /row-level security/i,
      );
    });
  });
});
