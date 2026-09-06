import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
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

const DATABASE_URL = process.env["DATABASE_URL"];

describe.skipIf(!DATABASE_URL)("PgSpecRepository against a real Postgres", () => {
  let pool: Pool;
  let db: DbClient;
  const createdWorkspaceIds: string[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await runMigrations(DATABASE_URL);
    ({ pool, db } = createDbClient(DATABASE_URL));
  });

  async function createWorkspace(name: string): Promise<string> {
    const [row] = await db.insert(workspaces).values({ name }).returning({ id: workspaces.id });
    if (!row) throw new Error("insert into workspaces did not return an id");
    createdWorkspaceIds.push(row.id);
    return row.id;
  }

  afterAll(async () => {
    if (!DATABASE_URL) return;
    // Cascades to every specs/layouts row created via these workspaces
    // (ON DELETE CASCADE, KAN-1223's schema) -- leaves the disposable
    // verification database clean rather than accumulating rows across runs.
    for (const id of createdWorkspaceIds) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    await pool?.end();
  });

  // --- 1. the shared behavioral contract -----------------------------

  runSpecRepositoryContractTests({
    createRepository: async () => {
      const workspaceId = await createWorkspace(`contract-${randomUUID()}`);
      return PgSpecRepository.create(db, workspaceId, "greeter", CONTRACT_FIXTURE_SOURCE);
    },
  });

  // --- 2. Postgres-specific verification ------------------------------

  describe("Postgres-specific behavior", () => {
    it("persists yaml_source, name, workspace_id, and an initial version of 1, readable via a raw query", async () => {
      const workspaceId = await createWorkspace("raw-query-check");
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
      const repoA = await PgSpecRepository.create(
        db,
        workspaceA,
        "spec-a",
        CONTRACT_FIXTURE_SOURCE,
      );
      await PgSpecRepository.create(db, workspaceB, "spec-b", CONTRACT_FIXTURE_SOURCE);

      const listA = await repoA.list();

      expect(listA.map((s) => s.name)).toEqual(["spec-a"]);
    });

    it("writeLayout stores layout_json queryable via a raw jsonb query", async () => {
      const workspaceId = await createWorkspace("layout-jsonb-check");
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
