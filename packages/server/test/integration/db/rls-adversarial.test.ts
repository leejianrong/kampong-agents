import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { layouts, specs, user, workspaceMembers, workspaces } from "../../../src/db/schema.js";
import { withWorkspaceScope } from "../../../src/db/workspace-scope.js";

// KAN-1232 (SLICES.md V5 build-plan step 12 + test plan): the adversarial
// counterpart to workspace-scope.test.ts. That suite proves RLS scopes an
// HONEST query correctly (a read with no WHERE clause only sees its own
// workspace; a write can't stamp another workspace's id). THIS suite proves
// RLS still holds when a query is deliberately CRAFTED to try to defeat it --
// an attacker-supplied WHERE naming the victim, a UNION reaching across
// tenants, an attempt to migrate a row between workspaces, a blanked session
// variable, and untrusted input shaped like SQL that tries to reach the
// `app.workspace_id` GUC. The property throughout: none of these can read or
// write another workspace's rows, and none can escalate the current scope.
//
// Runs only with DATABASE_URL set, against a NON-superuser role (a superuser
// bypasses FORCE RLS and makes every assertion below vacuous -- KAN-1388/CI
// provisions exactly such a role). Local instructions match the sibling
// db/* suites:
//   docker run --rm -d --name kampong-pg-test -p 15433:5432 \
//     -e POSTGRES_PASSWORD=postgres postgres:18
//   docker exec kampong-pg-test psql -U postgres \
//     -c "CREATE ROLE app_test LOGIN PASSWORD 'app_test' NOSUPERUSER NOBYPASSRLS;" \
//     -c "CREATE DATABASE kampong_test OWNER app_test;"
//   DATABASE_URL=postgres://app_test:app_test@localhost:15433/kampong_test \
//     npm run test:integration --workspace=packages/server

const DATABASE_URL = process.env["DATABASE_URL"];

describe.skipIf(!DATABASE_URL)("RLS cross-tenant isolation under adversarial queries", () => {
  let pool: Pool;
  let db: DbClient;
  const createdWorkspaceIds: string[] = [];
  const createdUserIds: string[] = [];

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
    for (const id of createdUserIds) {
      await db.delete(user).where(eq(user.id, id));
    }
    await pool?.end();
  });

  async function createWorkspace(name: string): Promise<string> {
    const [row] = await db
      .insert(workspaces)
      .values({ name, slug: randomUUID() })
      .returning({ id: workspaces.id });
    if (!row) throw new Error("insert into workspaces did not return an id");
    createdWorkspaceIds.push(row.id);
    return row.id;
  }

  async function createUser(): Promise<string> {
    const [row] = await db
      .insert(user)
      .values({ name: "adv", email: `${randomUUID()}@example.com` })
      .returning({ id: user.id });
    if (!row) throw new Error("insert into user did not return an id");
    createdUserIds.push(row.id);
    return row.id;
  }

  async function createSpec(workspaceId: string, name: string): Promise<string> {
    const [row] = await withWorkspaceScope(db, workspaceId, (tx) =>
      tx.insert(specs).values({ workspaceId, name, yamlSource: "agent: {}\n" }).returning({
        id: specs.id,
      }),
    );
    if (!row) throw new Error("insert into specs did not return an id");
    return row.id;
  }

  /** Drizzle wraps the driver error in a generic error and attaches the real one as `.cause` -- assert against that (mirrors workspace-scope.test.ts). */
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

  // --- an attacker-supplied WHERE naming the victim can't bypass RLS -------

  it("a read scoped to A that explicitly filters WHERE workspace_id = B still returns zero rows", async () => {
    const workspaceA = await createWorkspace("adv-where-a");
    const workspaceB = await createWorkspace("adv-where-b");
    await createSpec(workspaceB, "b-secret");

    // The query names B's id directly -- but it runs scoped to A, and RLS is
    // ANDed onto every table access regardless of the query's own predicate,
    // so the victim's rows are invisible. RLS is not something a caller can
    // opt out of by supplying their own WHERE.
    const rows = await withWorkspaceScope(db, workspaceA, (tx) =>
      tx.select({ id: specs.id }).from(specs).where(eq(specs.workspaceId, workspaceB)),
    );
    expect(rows).toEqual([]);
  });

  it("a UNION ALL reaching for the victim's workspace_id leaks none of its rows", async () => {
    const workspaceA = await createWorkspace("adv-union-a");
    const workspaceB = await createWorkspace("adv-union-b");
    await createSpec(workspaceA, "a-own");
    await createSpec(workspaceB, "b-victim");

    // A raw UNION ALL: the second branch explicitly targets B. Both branches
    // read `specs`, so RLS filters BOTH to workspace A -- the victim's row
    // cannot ride in on the second branch.
    const seen = await withWorkspaceScope(db, workspaceA, async (tx) => {
      const result = await tx.execute(
        sql`SELECT workspace_id FROM specs WHERE workspace_id = ${workspaceA}
            UNION ALL
            SELECT workspace_id FROM specs WHERE workspace_id = ${workspaceB}`,
      );
      return result.rows as { workspace_id: string }[];
    });
    expect(seen.every((r) => r.workspace_id === workspaceA)).toBe(true);
    expect(seen.some((r) => r.workspace_id === workspaceB)).toBe(false);
  });

  // --- a row cannot be migrated between tenants ----------------------------

  it("an UPDATE that tries to move A's own spec into workspace B is rejected by WITH CHECK", async () => {
    const workspaceA = await createWorkspace("adv-migrate-a");
    const workspaceB = await createWorkspace("adv-migrate-b");
    const specAId = await createSpec(workspaceA, "a-movable");

    // Scoped to A, A can see and update its own row -- but re-stamping it with
    // B's workspace_id makes the resulting row fail A's WITH CHECK (the new
    // row no longer belongs to the scoped workspace), so Postgres rejects it.
    // A tenant cannot hand its rows to another tenant.
    await expectRejectionCause(
      withWorkspaceScope(db, workspaceA, (tx) =>
        tx.update(specs).set({ workspaceId: workspaceB }).where(eq(specs.id, specAId)),
      ),
      /row-level security/i,
    );

    // The row is untouched and still A's.
    const stillA = await withWorkspaceScope(db, workspaceA, (tx) =>
      tx.select({ workspaceId: specs.workspaceId }).from(specs).where(eq(specs.id, specAId)),
    );
    expect(stillA).toEqual([{ workspaceId: workspaceA }]);
  });

  // --- a blanked / reset session variable fails closed, never open ---------

  it("blanking app.workspace_id mid-transaction reveals zero rows, not every workspace's rows", async () => {
    const workspaceA = await createWorkspace("adv-blank-a");
    await createSpec(workspaceA, "a-hidden");

    // Set the GUC to the empty string (what a careless RESET-like motion
    // produces) inside a transaction, then read. The policies normalize an
    // empty setting to "no workspace" and return nothing -- the failure mode
    // is closed (see nothing), never open (see everything).
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.workspace_id', '', true)`);
      return tx.select({ id: specs.id }).from(specs);
    });
    expect(rows).toEqual([]);
  });

  it("setting app.workspace_id to a non-UUID value fails the query loudly rather than matching anything", async () => {
    await expectRejectionCause(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.workspace_id', 'not-a-uuid', true)`);
        return tx.select().from(specs);
      }),
      /invalid input syntax for type uuid/i,
    );
  });

  // --- untrusted input shaped like SQL is data, and cannot reach the GUC ----

  it("a spec name shaped like an app.workspace_id-changing SQL payload is stored as a literal, and does not escalate scope", async () => {
    const workspaceA = await createWorkspace("adv-injection-a");
    const workspaceB = await createWorkspace("adv-injection-b");
    await createSpec(workspaceB, "b-target");

    // A parameterized value that, as raw SQL, would try to re-point the GUC at
    // B. Because Drizzle/node-postgres send it as a bound parameter, it can
    // only ever be a string column value -- it is never executed, so
    // app.workspace_id stays A and B's rows stay hidden.
    const payload = `'; select set_config('app.workspace_id','${workspaceB}',true); --`;
    const injectedId = await createSpec(workspaceA, payload);

    const seen = await withWorkspaceScope(db, workspaceA, async (tx) => {
      // The payload round-trips as a plain name...
      const named = await tx
        .select({ name: specs.name })
        .from(specs)
        .where(eq(specs.id, injectedId));
      // ...and the scope is still A: B's rows remain invisible.
      const all = await tx.select({ workspaceId: specs.workspaceId }).from(specs);
      return { named, all };
    });
    expect(seen.named).toEqual([{ name: payload }]);
    expect(seen.all.some((r) => r.workspaceId === workspaceB)).toBe(false);
  });

  // --- the same guarantees hold on layouts and workspace_members -----------

  it("layouts and workspace_members are equally invisible cross-tenant under an attacker-supplied WHERE", async () => {
    const workspaceA = await createWorkspace("adv-tables-a");
    const workspaceB = await createWorkspace("adv-tables-b");
    const specBId = await createSpec(workspaceB, "b-spec");
    const memberUser = await createUser();
    await withWorkspaceScope(db, workspaceB, (tx) =>
      tx.insert(layouts).values({ workspaceId: workspaceB, specId: specBId, layoutJson: {} }),
    );
    await withWorkspaceScope(db, workspaceB, (tx) =>
      tx
        .insert(workspaceMembers)
        .values({ workspaceId: workspaceB, userId: memberUser, role: "member" }),
    );

    const seenLayouts = await withWorkspaceScope(db, workspaceA, (tx) =>
      tx.select({ id: layouts.id }).from(layouts).where(eq(layouts.workspaceId, workspaceB)),
    );
    const seenMembers = await withWorkspaceScope(db, workspaceA, (tx) =>
      tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceB)),
    );
    expect(seenLayouts).toEqual([]);
    expect(seenMembers).toEqual([]);
  });
});
