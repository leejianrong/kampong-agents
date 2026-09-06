import { sql } from "drizzle-orm";
import type { DbClient } from "./client.js";

// KAN-1225 (ADR-0014): the database-enforced backstop behind
// `PgSpecRepository`'s (and every other tenant-scoped query's)
// application-layer `WHERE workspace_id = ...` scoping. Sets the
// `app.workspace_id` Postgres session variable the RLS policies on
// `workspace_members`, `specs`, and `layouts` key off of
// (`drizzle/0001_enable_row_level_security.sql`) for the duration of one
// transaction, then runs a caller-supplied callback inside that same
// transaction.
//
// Deliberately NOT wired into any HTTP route, Fastify middleware, or
// `PgSpecRepository` itself -- that wiring (once per authenticated
// request) is KAN-1227's job, not this card's. This module only needs to
// exist, be correct, and be directly tested against a raw `DbClient`
// (test/integration/db/workspace-scope.test.ts) -- not exercised through
// any route.
//
// Why a transaction, not a bare connection-level SET: `SET LOCAL` (and
// `set_config(..., true)` below, its parameterized equivalent) is only
// valid inside a transaction block, and it automatically reverts at
// COMMIT/ROLLBACK -- exactly the lifetime we want ("scoped to this one
// request/operation, then gone"). That also means a pooled connection can
// never leak one caller's workspace scoping into whatever the next caller
// happens to borrow that same connection for after this transaction ends.
//
// Why `set_config(...)`, not a string-interpolated
// `SET LOCAL app.workspace_id = '<value>'`: `SET`/`SET LOCAL` are SQL
// *commands*, not expressions, so -- unlike `SELECT ... WHERE x = $1` --
// they do not accept the normal `$n`-style query parameter placeholders
// Drizzle/node-postgres use everywhere else. Naively concatenating a
// caller-supplied `workspaceId` into a `SET LOCAL` string would be a real
// SQL-injection risk. `set_config(setting_name text, new_value text,
// is_local boolean)` is a regular SQL *function*, not a bare command, so a
// call to it goes through the ordinary parameterized-query path like any
// other query; `is_local: true` gives it the exact same "reverts at end of
// transaction" semantics `SET LOCAL` has. This is Postgres's own
// documented mechanism for setting a GUC to a dynamic, untrusted value
// safely (see the `set_config` entry in the Postgres "System Administration
// Functions" docs) -- not a workaround invented for this card.
//
// Defense in depth on top of that: `workspaceId` is validated as
// well-formed-UUID-shaped *before* it ever reaches a query. The RLS
// policies themselves cast the setting to `::uuid`, so a non-UUID-shaped
// value would fail loudly at query time regardless -- but validating here
// gives a caller an immediate, unambiguous `InvalidWorkspaceIdError`
// instead of a possibly-confusing failure surfacing from deep inside
// whatever `callback` happens to run first.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidWorkspaceIdError extends Error {
  constructor(workspaceId: string) {
    super(`"${workspaceId}" is not a well-formed UUID; refusing to scope a transaction to it.`);
    this.name = "InvalidWorkspaceIdError";
  }
}

/**
 * The transaction type `withWorkspaceScope`'s callback receives: whatever
 * `DbClient["transaction"]`'s own callback-parameter type is. Derived via
 * `Parameters<...>` (rather than re-declaring/importing Drizzle's
 * `NodePgTransaction<...>` generic by hand) so this stays in sync with
 * `DbClient` automatically if that type ever changes.
 */
type ScopedTx = Parameters<DbClient["transaction"]>[0] extends (tx: infer Tx) => unknown
  ? Tx
  : never;

/**
 * Runs `callback` inside a Postgres transaction with `app.workspace_id` set
 * to `workspaceId` for that transaction's duration -- the session variable
 * the RLS policies on `workspace_members`, `specs`, and `layouts` key off
 * of. Any query `callback` runs against those tables, through the `tx` it's
 * given, is transparently scoped to this one workspace by Postgres itself
 * -- including a query with no `WHERE workspace_id = ...` clause of its
 * own.
 *
 * Throws `InvalidWorkspaceIdError` synchronously, before opening a
 * transaction or touching the database at all, if `workspaceId` isn't a
 * well-formed UUID.
 */
export async function withWorkspaceScope<T>(
  db: DbClient,
  workspaceId: string,
  callback: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(workspaceId)) {
    throw new InvalidWorkspaceIdError(workspaceId);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return callback(tx);
  });
}
