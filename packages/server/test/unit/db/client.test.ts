import { afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createDbClient, getDatabaseUrl } from "../../../src/db/client.js";

// KAN-1223: this card's own brief is explicit that createDbClient/
// getDatabaseUrl are "needed to actually run migrations" but are NOT wired
// into server.ts, any route, or the wiring-check -- so this suite only
// proves the module's own, self-contained behavior (env parsing, and that
// constructing a `pg.Pool` doesn't itself open a network connection),
// exactly the "meaningfully testable without a live DB" scope this card's
// brief asks for.

describe("getDatabaseUrl", () => {
  it("throws a clear, actionable error when DATABASE_URL is unset", () => {
    expect(() => getDatabaseUrl({})).toThrow(/DATABASE_URL is not set/);
  });

  it("returns the value from the given env", () => {
    const url = "postgres://user:pass@localhost:5432/kampong";
    expect(getDatabaseUrl({ DATABASE_URL: url })).toBe(url);
  });

  it("defaults to process.env when no env is given", () => {
    const previous = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = "postgres://user:pass@localhost:5432/kampong";
    try {
      expect(getDatabaseUrl()).toBe("postgres://user:pass@localhost:5432/kampong");
    } finally {
      if (previous === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = previous;
    }
  });
});

describe("createDbClient", () => {
  let pool: Pool | undefined;

  afterEach(async () => {
    // node-postgres's Pool constructor never opens a connection eagerly
    // (confirmed by these tests completing instantly against an
    // unreachable host below), but end() it anyway so a stray idle-client
    // timer never keeps the test process alive.
    await pool?.end();
    pool = undefined;
  });

  it("constructs a Pool + Drizzle client pair without opening a network connection", () => {
    // A syntactically valid but unreachable connection string -- if
    // constructing a Pool eagerly connected, this would hang or throw here.
    const result = createDbClient("postgres://user:pass@127.0.0.1:1/kampong");
    pool = result.pool;
    expect(result.pool).toBeInstanceOf(Pool);
    expect(result.db).toBeDefined();
  });

  it("uses getDatabaseUrl() (and so throws the same error) when called with no argument", () => {
    const previous = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];
    try {
      expect(() => createDbClient()).toThrow(/DATABASE_URL is not set/);
    } finally {
      if (previous !== undefined) process.env["DATABASE_URL"] = previous;
    }
  });
});
