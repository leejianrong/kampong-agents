import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { workspaces } from "../../../src/db/schema.js";
import { withWorkspaceScope } from "../../../src/db/workspace-scope.js";
import { PgStateStore } from "../../../src/run/pg-state-store.js";
import { runStateStoreContract } from "../../../../engine/test/unit/state-store-contract.js";

// KAM-113 (ADR-0028): the hosted StateStore against a real Postgres, as the non-superuser role (a superuser
// bypasses FORCE RLS). Two parts: the SAME contract suite the SQLite store passes, and cross-tenant isolation:
// two workspaces using identical keys never see, overwrite, list or delete each other's entries, and the
// table is unreadable without a workspace scope. Skips without DATABASE_URL.

const DATABASE_URL = process.env["DATABASE_URL"];

describe.skipIf(!DATABASE_URL)("PgStateStore against a real Postgres", () => {
  let pool: Pool;
  let db: DbClient;
  const createdWorkspaceIds: string[] = [];

  async function createWorkspace(): Promise<string> {
    const [row] = await db
      .insert(workspaces)
      .values({ name: "state", slug: randomUUID() })
      .returning({ id: workspaces.id });
    createdWorkspaceIds.push(row!.id);
    return row!.id;
  }

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await runMigrations(DATABASE_URL);
    ({ pool, db } = createDbClient(DATABASE_URL));
  });

  afterAll(async () => {
    if (!DATABASE_URL) return;
    for (const id of createdWorkspaceIds) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    await pool?.end();
  });

  // The shared contract: each case gets a store on a fresh workspace (so it starts empty), and a peer is a
  // second store object for the same workspace.
  const workspaceOf = new WeakMap<object, string>();
  runStateStoreContract("Postgres", {
    async create(clock) {
      const id = await createWorkspace();
      const store = new PgStateStore(db, id, { clock });
      workspaceOf.set(store, id);
      return store;
    },
    createPeer: (first, clock) => new PgStateStore(db, workspaceOf.get(first)!, { clock }),
  });

  describe("cross-tenant isolation", () => {
    it("the same key in two workspaces is two entries", async () => {
      const a = new PgStateStore(db, await createWorkspace());
      const b = new PgStateStore(db, await createWorkspace());
      await a.put("dedupe:wf:step:k1", { who: "a" });
      expect(await b.get("dedupe:wf:step:k1")).toBeUndefined();
      expect(await b.exists("dedupe:wf:step:k1")).toBe(false);
      await b.put("dedupe:wf:step:k1", { who: "b" });
      expect(await a.get("dedupe:wf:step:k1")).toEqual({ who: "a" });
      expect(await b.get("dedupe:wf:step:k1")).toEqual({ who: "b" });
    });

    it("putIfAbsent in one workspace is not blocked by another's claim of the same key", async () => {
      const a = new PgStateStore(db, await createWorkspace());
      const b = new PgStateStore(db, await createWorkspace());
      expect(await a.putIfAbsent("claim", 1)).toBe(true);
      expect(await b.putIfAbsent("claim", 2)).toBe(true);
      expect(await a.putIfAbsent("claim", 3)).toBe(false);
    });

    it("list and delete only touch the caller's workspace", async () => {
      const a = new PgStateStore(db, await createWorkspace());
      const b = new PgStateStore(db, await createWorkspace());
      await a.put("p:1", "a1");
      await b.put("p:1", "b1");
      await b.put("p:2", "b2");
      expect(await a.list("p:")).toEqual([{ key: "p:1", value: "a1" }]);
      expect(await a.delete("p:2")).toBe(false);
      expect(await b.delete("p:1")).toBe(true);
      expect(await a.get("p:1")).toBe("a1");
      expect(await b.list("p:")).toEqual([{ key: "p:2", value: "b2" }]);
    });

    it("RLS holds beneath the store: a scoped query with no WHERE sees only its own workspace, an unscoped one sees nothing, and a write stamped with another workspace is rejected", async () => {
      const wa = await createWorkspace();
      const wb = await createWorkspace();
      await new PgStateStore(db, wa).put("rls", "a");
      await new PgStateStore(db, wb).put("rls", "b");

      const scoped = await withWorkspaceScope(db, wa, async (tx) => {
        const res = await tx.execute(sql`SELECT workspace_id, value FROM state_entries`);
        return res.rows as Array<{ workspace_id: string; value: string }>;
      });
      expect(scoped).toEqual([{ workspace_id: wa, value: "a" }]);

      const unscoped = await pool.query("SELECT * FROM state_entries");
      expect(unscoped.rowCount).toBe(0);

      let caught: unknown;
      try {
        await withWorkspaceScope(db, wa, (tx) =>
          tx.execute(
            sql`INSERT INTO state_entries (workspace_id, key, value) VALUES (${wb}, 'x', '1'::jsonb)`,
          ),
        );
      } catch (err) {
        caught = err;
      }
      expect(((caught as Error)?.cause as Error)?.message).toMatch(/row-level security/);
    });

    it("deleting a workspace removes its entries", async () => {
      const id = await createWorkspace();
      await new PgStateStore(db, id).put("gone", true);
      await db.delete(workspaces).where(eq(workspaces.id, id));
      const check = await withWorkspaceScope(db, id, async (tx) => {
        return (await tx.execute(sql`SELECT 1 FROM state_entries`)).rows.length;
      });
      expect(check).toBe(0);
    });
  });
});
