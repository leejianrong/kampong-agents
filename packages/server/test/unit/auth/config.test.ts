import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createAuth } from "../../../src/auth/config.js";

// KAN-1226 (ADR-0015): no live Postgres needed here (matches
// test/unit/server.test.ts's own reasoning: constructing a Pool never opens
// a connection, and Better Auth's Drizzle-adapter schema check "inspect[s]
// local schema metadata without opening a connection"). The real, DB-backed
// HTTP behavior (sign-up/sign-in/organization-create, and the GitHub
// sign-in-social redirect check below -- that one writes an OAuth-state
// `verification` row, so it genuinely needs a live database, unlike the
// two tests in this file) is covered at the integration layer
// (test/integration/db/auth.test.ts). This suite proves the one thing that
// doesn't need a live database at all: createAuth() constructs
// successfully with every plugin this card registers (organization, sso)
// wired up -- a `SchemaMismatchError` here (verified while building this
// card: forgetting the dormant `sso` plugin's own `ssoProvider` table
// triggers exactly this) would mean the schema and the Better Auth config
// have drifted apart -- and that GitHub sign-in is/isn't offered as a
// provider at all depending on whether its env vars are set (still no DB
// write on the *unset* path, since Better Auth rejects an unknown provider
// before ever touching the adapter).

function dbForThisTest(): { db: DbClient; pool: Pool } {
  return createDbClient("postgres://user:pass@127.0.0.1:1/kampong");
}

describe("createAuth", () => {
  // Every env value each test needs is passed explicitly as createAuth's
  // own `env` argument (never process.env mutation), so the only cleanup
  // needed is closing each test's own Pool.
  let pool: Pool | undefined;

  afterEach(async () => {
    await pool?.end();
    pool = undefined;
  });

  it("constructs without throwing (schema/plugin config is internally consistent)", () => {
    const { db, pool: p } = dbForThisTest();
    pool = p;
    expect(() =>
      createAuth(db, { BETTER_AUTH_SECRET: "unit-test-secret-not-for-prod" }),
    ).not.toThrow();
  });

  it("omits GitHub sign-in (without throwing) when GITHUB_CLIENT_ID/SECRET are unset", async () => {
    const { db, pool: p } = dbForThisTest();
    pool = p;
    const auth = createAuth(db, { BETTER_AUTH_SECRET: "unit-test-secret-not-for-prod" });

    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ provider: "github", callbackURL: "/" }),
      }),
    );
    // No github provider registered -- Better Auth rejects the request
    // rather than silently succeeding with a bogus/missing provider.
    expect(response.status).not.toBe(200);
  });
});
