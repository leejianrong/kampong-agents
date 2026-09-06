import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createDbClient } from "../../../src/db/client.js";
import { InvalidWorkspaceIdError, withWorkspaceScope } from "../../../src/db/workspace-scope.js";

// KAN-1225: the part of `withWorkspaceScope` (src/db/workspace-scope.ts)
// that's meaningfully testable without a live database -- UUID validation
// happens synchronously, before any transaction is opened or any query is
// sent, so this proves that validation is real (and fails fast, without
// ever touching the network) without needing DATABASE_URL. The rest of the
// helper's behavior (that it actually scopes RLS-enforced queries
// correctly) needs a real Postgres and lives at the integration layer:
// test/integration/db/workspace-scope.test.ts.

describe("withWorkspaceScope", () => {
  let pool: Pool | undefined;

  afterEach(async () => {
    await pool?.end();
    pool = undefined;
  });

  it("rejects a non-UUID-shaped workspaceId before opening a transaction", async () => {
    // An unreachable host: if validation happened lazily (e.g. inside the
    // transaction), this would hang or throw a connection error instead of
    // the intended InvalidWorkspaceIdError.
    const { db, pool: p } = createDbClient("postgres://user:pass@127.0.0.1:1/kampong");
    pool = p;

    await expect(
      withWorkspaceScope(db, "not-a-uuid", async () => {
        throw new Error("callback should never run for an invalid workspaceId");
      }),
    ).rejects.toThrow(InvalidWorkspaceIdError);
  });

  it("rejects an empty string", async () => {
    const { db, pool: p } = createDbClient("postgres://user:pass@127.0.0.1:1/kampong");
    pool = p;

    await expect(withWorkspaceScope(db, "", async () => "unreachable")).rejects.toThrow(
      /not a well-formed UUID/,
    );
  });

  it("rejects a UUID-shaped string with SQL metacharacters appended (defense in depth)", async () => {
    const { db, pool: p } = createDbClient("postgres://user:pass@127.0.0.1:1/kampong");
    pool = p;

    const maliciousValue = "11111111-1111-1111-1111-111111111111'; DROP TABLE specs; --";

    await expect(withWorkspaceScope(db, maliciousValue, async () => "unreachable")).rejects.toThrow(
      InvalidWorkspaceIdError,
    );
  });

  it("accepts a well-formed UUID and only fails once it actually tries to reach the database", async () => {
    const { db, pool: p } = createDbClient("postgres://user:pass@127.0.0.1:1/kampong");
    pool = p;

    // A syntactically valid UUID against an unreachable host: validation
    // passes, so this should fail with a connection error (proving the
    // callback path -- opening a transaction -- was actually reached), not
    // InvalidWorkspaceIdError.
    let caught: unknown;
    try {
      await withWorkspaceScope(
        db,
        "11111111-1111-1111-1111-111111111111",
        async () => "unreachable",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(InvalidWorkspaceIdError);
  });
});
