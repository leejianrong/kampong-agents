import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/db/migrate.js";

// KAN-1223, item 7/8: "meaningfully testable without a live DB" is the
// schema-module unit tests (test/unit/db/schema.test.ts) -- this is the
// other half, actually applying the generated migrations to a real
// Postgres and confirming the resulting tables/columns/constraints. That
// needs live infra, so per this repo's own layering (AGENTS.md: "no live
// network calls in unit/integration tests" for the recorded/mocked case,
// but this repo has no existing precedent either way for a test that
// genuinely needs a live external database -- packages/engine's own
// integration suite mocks/injects its network seam instead of using a
// live service) it lives at the integration layer and self-skips when no
// database is configured, rather than being wired into CI unconditionally.
//
// FLAGGED GAP (not solved by this card, out of scope per its own brief):
// .github/workflows/ci.yml's `integration` job does not start a Postgres
// service container and never sets DATABASE_URL, so this test is always
// skipped in CI as it stands today -- it only runs when a developer
// exports DATABASE_URL locally (e.g. against the disposable container used
// for this card's own manual verification). Wiring a Postgres service
// container into CI is a real, deliberate infra change this card's scope
// explicitly does not include; flagged here rather than guessed at.
//
// To run this locally:
//   docker run --rm -d --name kampong-pg-test -p 15433:5432 \
//     -e POSTGRES_PASSWORD=postgres postgres:18
//   DATABASE_URL=postgres://postgres:postgres@localhost:15433/postgres \
//     npm run test:integration --workspace=packages/server
//   docker stop kampong-pg-test

const DATABASE_URL = process.env["DATABASE_URL"];

describe.skipIf(!DATABASE_URL)("drizzle migrations against a real Postgres", () => {
  let pool: Pool;

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await runMigrations(DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates exactly the four expected tables in the public schema", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    const tableNames = rows.map((r) => r.table_name);
    expect(tableNames).toEqual(
      expect.arrayContaining(["workspaces", "workspace_members", "specs", "layouts"]),
    );
    // Exactly these four -- no byok_keys/runs table sneaking in, and no
    // Drizzle-internal migrations-tracking table counted (it lives in its
    // own "drizzle" schema, not "public").
    expect(tableNames.sort()).toEqual(["layouts", "specs", "workspace_members", "workspaces"]);
  });

  it("gives workspaces the expected columns", async () => {
    const { rows } = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'workspaces' ORDER BY ordinal_position`,
    );
    expect(rows).toEqual([
      { column_name: "id", data_type: "uuid" },
      { column_name: "name", data_type: "text" },
      { column_name: "created_at", data_type: "timestamp with time zone" },
    ]);
  });

  it("gives specs the expected columns", async () => {
    const { rows } = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'specs' ORDER BY ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "id",
      "workspace_id",
      "name",
      "yaml_source",
      "version",
      "created_at",
      "updated_at",
    ]);
  });

  it("enforces workspace_id/spec_id foreign keys with ON DELETE CASCADE", async () => {
    const { rows } = await pool.query<{
      table_name: string;
      column_name: string;
      foreign_table: string;
      delete_rule: string;
    }>(
      `SELECT
         tc.table_name,
         kcu.column_name,
         ccu.table_name AS foreign_table,
         rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
       JOIN information_schema.referential_constraints rc
         ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
       ORDER BY tc.table_name, kcu.column_name`,
    );

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table_name: "layouts",
          column_name: "spec_id",
          foreign_table: "specs",
          delete_rule: "CASCADE",
        }),
        expect.objectContaining({
          table_name: "layouts",
          column_name: "workspace_id",
          foreign_table: "workspaces",
          delete_rule: "CASCADE",
        }),
        expect.objectContaining({
          table_name: "specs",
          column_name: "workspace_id",
          foreign_table: "workspaces",
          delete_rule: "CASCADE",
        }),
        expect.objectContaining({
          table_name: "workspace_members",
          column_name: "workspace_id",
          foreign_table: "workspaces",
          delete_rule: "CASCADE",
        }),
      ]),
    );
  });

  it("gives workspace_members a composite primary key on (workspace_id, user_id)", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = 'workspace_members'
       ORDER BY kcu.ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["workspace_id", "user_id"]);
  });

  it("re-running migrations against an already-migrated database is a no-op, not an error", async () => {
    await expect(runMigrations(DATABASE_URL)).resolves.toBeUndefined();
  });
});
