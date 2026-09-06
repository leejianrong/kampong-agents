import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { runMigrations } from "../../../src/db/migrate.js";
import type { DbClient } from "../../../src/db/client.js";
import * as schema from "../../../src/db/schema.js";
import { workspaces } from "../../../src/db/schema.js";
import { PgSpecRepository } from "../../../src/db/spec-repository.js";
import {
  CONTRACT_FIXTURE_SOURCE,
  runSpecRepositoryContractTests,
} from "../../../../spec/test/integration/repository-contract.js";

// KAN-1224: verifies the Postgres-backed `SpecRepository` implementation
// (src/db/spec-repository.ts) against a real database, the same way
// KAN-1223's migrations.test.ts does -- self-skips when no DATABASE_URL is
// set (the same known, already-flagged CI gap KAN-1223 left open; not this
// card's job to fix). Two layers of proof:
//
// 1. The shared `SpecRepository` contract (packages/spec/test/integration/
//    repository-contract.ts) -- the exact same assertions
//    packages/cli/test/integration/spec-repository-contract.test.ts runs
//    against the filesystem-backed implementation. This is what actually
//    proves the abstraction is honest, not just that this class compiles
//    against the interface.
// 2. Postgres-specific checks this card's brief calls out explicitly:
//    inspecting the real rows written (not just going back through the
//    repository's own read methods), workspace-scoped `list()`, and
//    version/updated_at bookkeeping on a successful patch.
//
// To run this locally (mirrors KAN-1223's migrations.test.ts instructions):
//   docker run --rm -d --name kampong-pg-test -p 15433:5432 \
//     -e POSTGRES_PASSWORD=postgres postgres:18
//   DATABASE_URL=postgres://postgres:postgres@localhost:15433/postgres \
//     npm run test:integration --workspace=packages/server
//   docker stop kampong-pg-test
//
// KAN-1225 update: this suite pre-dates the RLS migration
// (drizzle/0001_enable_row_level_security.sql). `PgSpecRepository` itself
// is explicitly NOT wired through `withWorkspaceScope` in this card (that's
// KAN-1227's job -- see workspace-scope.ts's own docstring) -- so, exactly
// as RLS is designed to do, its plain, unscoped queries now fail closed
// (empty reads, rejected writes) unless the connection they run on has
// `app.workspace_id` set for the relevant workspace. To keep proving this
// repository's own behavioral contract without reaching into
// `PgSpecRepository`'s implementation (out of this card's scope) or
// weakening the RLS policy (defeats this card's entire point), this test's
// own DB client is a dedicated single-connection (`max: 1`) pool, and
// `scopeSession(workspaceId)` sets `app.workspace_id` at the *session*
// level (`set_config(..., false)`, not the transaction-scoped `true` used
// by the real `withWorkspaceScope` helper) directly on that one connection
// before each repository operation -- a deliberately test-only stand-in for
// the per-request middleware KAN-1227 will actually build, simulating "a
// request already scoped to this workspace" for a repository that doesn't
// yet scope itself.

const DATABASE_URL = process.env["DATABASE_URL"];

describe.skipIf(!DATABASE_URL)("PgSpecRepository against a real Postgres", () => {
  let pool: Pool;
  let db: DbClient;
  const createdWorkspaceIds: string[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await runMigrations(DATABASE_URL);
    // `max: 1`: exactly one physical connection for this whole suite, so a
    // session-level `set_config(..., false)` call (see `scopeSession`
    // below) reliably applies to every subsequent query this suite issues,
    // rather than landing on a different, unscoped connection some other
    // query happens to borrow from a bigger pool.
    pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    db = drizzle(pool, { schema }) as DbClient;
  });

  /**
   * Sets `app.workspace_id` for the remainder of this suite's single
   * connection's session (until the next call) -- see the file-level
   * comment for why this stands in for `withWorkspaceScope`'s real,
   * transaction-scoped `SET LOCAL`-equivalent here.
   */
  async function scopeSession(workspaceId: string): Promise<void> {
    await pool.query(`select set_config('app.workspace_id', $1, false)`, [workspaceId]);
  }

  async function createWorkspace(name: string): Promise<string> {
    // `workspaces` itself has no RLS policy (out of this card's scope --
    // see drizzle/0001_enable_row_level_security.sql's own comment), so
    // this insert needs no session-var scoping regardless.
    const [row] = await db.insert(workspaces).values({ name }).returning({ id: workspaces.id });
    if (!row) throw new Error("insert into workspaces did not return an id");
    createdWorkspaceIds.push(row.id);
    return row.id;
  }

  afterAll(async () => {
    if (!DATABASE_URL) return;
    // Cascades to every specs/layouts row created via these workspaces
    // (ON DELETE CASCADE, KAN-1223's schema) -- leaves the disposable
    // verification database clean rather than accumulating rows across
    // runs. Postgres's own FK-triggered cascade actions are not subject to
    // the referencing table's RLS policies, so this plain delete against
    // `workspaces` (which has none of its own) cascades cleanly regardless
    // of whatever `app.workspace_id` this connection's session currently
    // has set.
    for (const id of createdWorkspaceIds) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    await pool?.end();
  });

  // --- 1. the shared behavioral contract -----------------------------
  //
  // Each contract test calls `createRepository()` exactly once and then
  // only ever touches that one repository/workspace for the rest of that
  // test -- so scoping the session once here, right before creating the
  // seed spec row, is sufficient for every later call the contract makes
  // within that same test.

  runSpecRepositoryContractTests({
    createRepository: async () => {
      const workspaceId = await createWorkspace(`contract-${randomUUID()}`);
      await scopeSession(workspaceId);
      return PgSpecRepository.create(db, workspaceId, "greeter", CONTRACT_FIXTURE_SOURCE);
    },
  });

  // --- 2. Postgres-specific verification ------------------------------

  describe("Postgres-specific behavior", () => {
    it("persists yaml_source, name, workspace_id, and an initial version of 1, readable via a raw query", async () => {
      const workspaceId = await createWorkspace("raw-query-check");
      await scopeSession(workspaceId);
      await PgSpecRepository.create(db, workspaceId, "greeter", CONTRACT_FIXTURE_SOURCE);

      const { rows } = await pool.query<{
        name: string;
        yaml_source: string;
        workspace_id: string;
        version: number;
      }>(`SELECT name, yaml_source, workspace_id, version FROM specs WHERE workspace_id = $1`, [
        workspaceId,
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("greeter");
      expect(rows[0]?.yaml_source).toBe(CONTRACT_FIXTURE_SOURCE);
      expect(rows[0]?.workspace_id).toBe(workspaceId);
      expect(rows[0]?.version).toBe(1);
    });

    it("increments version and bumps updated_at on a successful applyPatchAndSave", async () => {
      const workspaceId = await createWorkspace("version-bump-check");
      await scopeSession(workspaceId);
      const repo = await PgSpecRepository.create(
        db,
        workspaceId,
        "greeter",
        CONTRACT_FIXTURE_SOURCE,
      );

      const result = await repo.applyPatchAndSave([
        { op: "set", path: ["agent", "goal"], value: "Updated via Postgres" },
      ]);
      expect(result.success).toBe(true);

      const { rows } = await pool.query<{
        version: number;
        updated_at: Date;
        created_at: Date;
      }>(`SELECT version, updated_at, created_at FROM specs WHERE workspace_id = $1`, [
        workspaceId,
      ]);

      expect(rows[0]?.version).toBe(2);
      expect(new Date(rows[0]!.updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(rows[0]!.created_at).getTime(),
      );
    });

    it("does not persist an invalid mutation's version bump either", async () => {
      const workspaceId = await createWorkspace("invalid-patch-version-check");
      await scopeSession(workspaceId);
      const repo = await PgSpecRepository.create(
        db,
        workspaceId,
        "greeter",
        CONTRACT_FIXTURE_SOURCE,
      );

      const result = await repo.applyPatchAndSave([
        { op: "set", path: ["agent", "workflow", 0, "step"], value: "" },
      ]);
      expect(result.success).toBe(false);

      const { rows } = await pool.query<{ version: number }>(
        `SELECT version FROM specs WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(rows[0]?.version).toBe(1);
    });

    it("list() only returns specs belonging to its own workspace", async () => {
      const workspaceA = await createWorkspace("list-scope-a");
      const workspaceB = await createWorkspace("list-scope-b");

      await scopeSession(workspaceA);
      const repoA = await PgSpecRepository.create(
        db,
        workspaceA,
        "spec-a",
        CONTRACT_FIXTURE_SOURCE,
      );
      await scopeSession(workspaceB);
      await PgSpecRepository.create(db, workspaceB, "spec-b", CONTRACT_FIXTURE_SOURCE);

      // Switch back to A before A's own repository queries again -- the
      // single shared connection's session is currently scoped to B.
      await scopeSession(workspaceA);
      const listA = await repoA.list();

      expect(listA.map((s) => s.name)).toEqual(["spec-a"]);
    });

    it("writeLayout stores layout_json queryable via a raw jsonb query", async () => {
      const workspaceId = await createWorkspace("layout-jsonb-check");
      await scopeSession(workspaceId);
      const repo = await PgSpecRepository.create(
        db,
        workspaceId,
        "greeter",
        CONTRACT_FIXTURE_SOURCE,
      );
      const layout = { "agent:greeter": { x: 42, y: 7 } };

      await repo.writeLayout(layout);

      const { rows } = await pool.query<{ layout_json: unknown }>(
        `SELECT layout_json FROM layouts WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.layout_json).toEqual(layout);
    });
  });
});
