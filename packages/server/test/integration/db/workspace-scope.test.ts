import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { layouts, specs, workspaceMembers, workspaces } from "../../../src/db/schema.js";
import { withWorkspaceScope } from "../../../src/db/workspace-scope.js";

// KAN-1225 (ADR-0014): proves the RLS policies added in
// drizzle/0001_enable_row_level_security.sql, together with
// `withWorkspaceScope` (src/db/workspace-scope.ts), actually enforce
// cross-workspace isolation against a real Postgres -- not just that the
// SQL runs without erroring. Follows the same skip-without-DATABASE_URL
// pattern as migrations.test.ts / spec-repository.test.ts.
//
// To run this locally (mirrors migrations.test.ts's own instructions):
//   docker run --rm -d --name kampong-pg-test -p 15433:5432 \
//     -e POSTGRES_PASSWORD=postgres postgres:18
//   DATABASE_URL=postgres://postgres:postgres@localhost:15433/postgres \
//     npm run test:integration --workspace=packages/server
//   docker stop kampong-pg-test
//
// A note on how fixture rows get created in this file (a deliberate,
// verified judgment call): this card's own brief suggested seeding two
// workspaces' rows via a *plain* `db.insert(...)` that bypasses
// `withWorkspaceScope` entirely, "simulating some code path that forgot to
// scope its query." Empirically, against a real Postgres, that does not
// work the way it might sound: because this card's policies are a single
// `FOR ALL USING (...) WITH CHECK (...)` policy (required so the same
// predicate covers both reads and writes, per this card's own brief) and
// `FORCE ROW LEVEL SECURITY` applies that policy even to the table-owning
// role, a plain `INSERT` with `app.workspace_id` unset is *itself* rejected
// by `WITH CHECK` ("new row violates row-level security policy") -- writes
// fail closed too, not only reads. Verified directly with a throwaway
// table/role via `psql` before writing this suite. So: fixture rows for
// the *read*-isolation tests below are created through
// `withWorkspaceScope`, each correctly scoped to its own workspace (the
// only way to get a row in at all under this policy) -- the property under
// test is that a subsequent *read* with no `WHERE workspace_id = ...`
// clause of its own, scoped only via the session variable, still can't see
// another workspace's rows. The "a write with no session variable set at
// all is itself rejected outright" property is proven directly, as its own
// assertion, in the "fail-closed" section below -- which is arguably a
// *stronger* proof of the brief's intent ("a query that forgot to scope
// still cannot leak data") than the literal instruction would have been.

const DATABASE_URL = process.env["DATABASE_URL"];

describe.skipIf(!DATABASE_URL)("Row-Level Security against a real Postgres", () => {
  let pool: Pool;
  let db: DbClient;
  const createdWorkspaceIds: string[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await runMigrations(DATABASE_URL);
    ({ pool, db } = createDbClient(DATABASE_URL));
  });

  afterAll(async () => {
    if (!DATABASE_URL) return;
    // Cascades to every specs/layouts/workspace_members row (ON DELETE
    // CASCADE) -- leaves the disposable verification database clean.
    // `workspaces` itself has no RLS policy (out of this card's scope), so
    // this plain delete is unaffected by anything above.
    for (const id of createdWorkspaceIds) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    await pool?.end();
  });

  async function createWorkspace(name: string): Promise<string> {
    const [row] = await db.insert(workspaces).values({ name }).returning({ id: workspaces.id });
    if (!row) throw new Error("insert into workspaces did not return an id");
    createdWorkspaceIds.push(row.id);
    return row.id;
  }

  /** Creates a `specs` row via `withWorkspaceScope`, correctly scoped to its own workspace -- see the file-level comment for why this is the only way to get a row in under this card's WITH CHECK policy. */
  async function createSpec(workspaceId: string, name: string): Promise<string> {
    const [row] = await withWorkspaceScope(db, workspaceId, (tx) =>
      tx
        .insert(specs)
        .values({ workspaceId, name, yamlSource: "agent: {}\n" })
        .returning({ id: specs.id }),
    );
    if (!row) throw new Error("insert into specs did not return an id");
    return row.id;
  }

  async function createLayout(workspaceId: string, specId: string): Promise<void> {
    await withWorkspaceScope(db, workspaceId, (tx) =>
      tx.insert(layouts).values({ workspaceId, specId, layoutJson: {} }),
    );
  }

  async function createMember(workspaceId: string, userId: string): Promise<void> {
    await withWorkspaceScope(db, workspaceId, (tx) =>
      tx.insert(workspaceMembers).values({ workspaceId, userId, role: "member" }),
    );
  }

  /**
   * Vitest's `.rejects.toThrow(pattern)` matches against the rejected
   * error's own `.message` -- but Drizzle wraps the real Postgres error in
   * a generic `DrizzleQueryError` ("Failed query: ...", no useful detail),
   * attaching the actual driver/Postgres error as `.cause` (standard
   * Node.js error-cause chaining). The real, useful error text (e.g. "new
   * row violates row-level security policy") lives on that `.cause`, which
   * is what this asserts against.
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

  // --- (c) confirm this suite's role is the actual table-owning role -----

  it("runs as the same role that owns the RLS-enabled tables (proving FORCE, not just ENABLE, is in play)", async () => {
    const { rows } = await pool.query<{ table_name: string; owner: string; current_user: string }>(
      `SELECT tablename AS table_name, tableowner AS owner, current_user
       FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('specs', 'layouts', 'workspace_members')`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.owner).toBe(row.current_user);
    }
  });

  it("has RLS enabled and forced on workspace_members, specs, and layouts, but not on workspaces", async () => {
    const { rows } = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname IN ('workspaces', 'workspace_members', 'specs', 'layouts') AND relkind = 'r'
       ORDER BY relname`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.relname, r]));
    expect(byName["workspace_members"]).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
    expect(byName["specs"]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    expect(byName["layouts"]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    expect(byName["workspaces"]).toMatchObject({
      relrowsecurity: false,
      relforcerowsecurity: false,
    });
  });

  // --- (b) fail-closed with no app.workspace_id set at all ---------------

  describe("fail-closed: no app.workspace_id set at all", () => {
    it("a plain unscoped write with no session variable set is itself rejected, not silently accepted", async () => {
      const workspaceId = await createWorkspace("fail-closed-write-check");

      await expectRejectionCause(
        db.insert(specs).values({ workspaceId, name: "unscoped", yamlSource: "agent: {}\n" }),
        /row-level security/i,
      );
    });

    it("a plain unscoped select sees zero rows across all three RLS tables, even though rows exist", async () => {
      const workspaceId = await createWorkspace("fail-closed-read-check");
      const specId = await createSpec(workspaceId, "some-spec");
      await createLayout(workspaceId, specId);
      await createMember(workspaceId, "22222222-2222-2222-2222-222222222222");

      // Not going through withWorkspaceScope at all: whatever this
      // connection's app.workspace_id happens to currently be (see the
      // next test for why that's not necessarily "never set" on a
      // connection this suite has already used), it is not this
      // workspace's id, so RLS must hide these rows regardless.
      const specRows = await db.select().from(specs);
      const layoutRows = await db.select().from(layouts);
      const memberRows = await db.select().from(workspaceMembers);

      expect(specRows.some((r) => r.workspaceId === workspaceId)).toBe(false);
      expect(layoutRows.some((r) => r.workspaceId === workspaceId)).toBe(false);
      expect(memberRows.some((r) => r.workspaceId === workspaceId)).toBe(false);
    });

    it("a plain unscoped select still fails closed (not errors, not leaks) on a connection withWorkspaceScope has already used", async () => {
      // Postgres quirk, verified directly against a real server while
      // building this migration (see drizzle/0001_enable_row_level_
      // security.sql's own comment): the *first* time a connection's
      // session ever sets a custom GUC like app.workspace_id (exactly what
      // the createSpec() call just above/below does, via
      // withWorkspaceScope), Postgres creates a session-level placeholder
      // for it -- so `current_setting('app.workspace_id', true)` reports an
      // *empty string*, not NULL, on every later transaction on that same
      // connection, even after the SET LOCAL value reverts at COMMIT. This
      // suite's connection has already been used by withWorkspaceScope
      // several times by this point in the file -- so this test is exactly
      // the "connection has history" case the migration's NULLIF(...)
      // normalization exists to keep fail-closed (zero rows, not a raised
      // `invalid input syntax for type uuid: ""` error) rather than merely
      // the easier, always-passes "totally fresh connection" case.
      const workspaceId = await createWorkspace("post-scope-fail-closed-check");
      await createSpec(workspaceId, "touch-connection-again");

      const rows = await db.select({ workspaceId: specs.workspaceId }).from(specs);
      expect(rows.some((r) => r.workspaceId === workspaceId)).toBe(false);
    });

    it("setting app.workspace_id to a non-UUID-shaped string fails the query rather than silently matching", async () => {
      await expectRejectionCause(
        db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.workspace_id', 'not-a-uuid', true)`);
          return tx.select().from(specs);
        }),
        /invalid input syntax for type uuid/i,
      );
    });
  });

  // --- (a) reads through the helper are correctly workspace-scoped -------

  describe("reads scoped by withWorkspaceScope", () => {
    it("a query with no WHERE workspace_id clause at all only sees its own workspace's specs/layouts/members", async () => {
      const workspaceA = await createWorkspace("read-isolation-a");
      const workspaceB = await createWorkspace("read-isolation-b");

      const specAId = await createSpec(workspaceA, "spec-a");
      const specBId = await createSpec(workspaceB, "spec-b");
      await createLayout(workspaceA, specAId);
      await createLayout(workspaceB, specBId);
      await createMember(workspaceA, "33333333-3333-3333-3333-333333333333");
      await createMember(workspaceB, "44444444-4444-4444-4444-444444444444");

      const seenSpecs = await withWorkspaceScope(db, workspaceA, (tx) => tx.select().from(specs));
      const seenLayouts = await withWorkspaceScope(db, workspaceA, (tx) =>
        tx.select().from(layouts),
      );
      const seenMembers = await withWorkspaceScope(db, workspaceA, (tx) =>
        tx.select().from(workspaceMembers),
      );

      expect(seenSpecs.map((s) => s.id)).toEqual([specAId]);
      expect(seenLayouts.map((l) => l.specId)).toEqual([specAId]);
      expect(seenMembers.map((m) => m.workspaceId)).toEqual([workspaceA]);
    });

    it("scoping to workspace B instead sees only B's rows -- the same query, a different result", async () => {
      const workspaceA = await createWorkspace("read-isolation-a2");
      const workspaceB = await createWorkspace("read-isolation-b2");

      await createSpec(workspaceA, "spec-a2");
      const specBId = await createSpec(workspaceB, "spec-b2");

      const seenAsB = await withWorkspaceScope(db, workspaceB, (tx) => tx.select().from(specs));
      expect(seenAsB.map((s) => s.id)).toEqual([specBId]);
    });
  });

  // --- (d) writes through the helper cannot affect another workspace -----

  describe("writes scoped by withWorkspaceScope", () => {
    it("an UPDATE scoped to workspace A affects zero rows of workspace B's spec", async () => {
      const workspaceA = await createWorkspace("write-isolation-update-a");
      const workspaceB = await createWorkspace("write-isolation-update-b");
      const specBId = await createSpec(workspaceB, "victim");

      // No WHERE clause restricting to specBId -- an update over the
      // *entire* table, scoped only by the session variable. If RLS were
      // not enforced (or not forced against this owning role), this would
      // clobber workspace B's row too.
      await withWorkspaceScope(db, workspaceA, (tx) =>
        tx.update(specs).set({ name: "renamed-by-a" }),
      );

      const stillB = await withWorkspaceScope(db, workspaceB, (tx) =>
        tx.select({ name: specs.name }).from(specs).where(eq(specs.id, specBId)),
      );
      expect(stillB).toEqual([{ name: "victim" }]);
    });

    it("a DELETE scoped to workspace A affects zero rows of workspace B's spec", async () => {
      const workspaceA = await createWorkspace("write-isolation-delete-a");
      const workspaceB = await createWorkspace("write-isolation-delete-b");
      const specBId = await createSpec(workspaceB, "victim-2");

      // Again, no WHERE clause of its own -- a delete over the whole table.
      await withWorkspaceScope(db, workspaceA, (tx) => tx.delete(specs));

      const stillB = await withWorkspaceScope(db, workspaceB, (tx) =>
        tx.select({ id: specs.id }).from(specs).where(eq(specs.id, specBId)),
      );
      expect(stillB).toEqual([{ id: specBId }]);
    });

    it("an INSERT scoped to workspace A stamped with workspace B's id is rejected by WITH CHECK", async () => {
      const workspaceA = await createWorkspace("write-isolation-insert-a");
      const workspaceB = await createWorkspace("write-isolation-insert-b");

      await expectRejectionCause(
        withWorkspaceScope(db, workspaceA, (tx) =>
          tx.insert(specs).values({
            workspaceId: workspaceB,
            name: "smuggled",
            yamlSource: "agent: {}\n",
          }),
        ),
        /row-level security/i,
      );

      // Confirm nothing was smuggled into B either.
      const seenAsB = await withWorkspaceScope(db, workspaceB, (tx) =>
        tx.select({ id: specs.id }).from(specs),
      );
      expect(seenAsB).toEqual([]);
    });

    it("an INSERT scoped to workspace A stamped with workspace A's own id succeeds normally", async () => {
      const workspaceA = await createWorkspace("write-isolation-insert-ok-a");

      await withWorkspaceScope(db, workspaceA, (tx) =>
        tx
          .insert(specs)
          .values({ workspaceId: workspaceA, name: "legit", yamlSource: "agent: {}\n" }),
      );

      const seen = await withWorkspaceScope(db, workspaceA, (tx) =>
        tx.select({ name: specs.name }).from(specs),
      );
      expect(seen).toEqual([{ name: "legit" }]);
    });
  });
});
