import { sql } from "drizzle-orm";
import type { PutOptions, StateClock, StateStore, StateValue } from "@kampong/engine";
import type { DbClient } from "../db/client.js";
import { withWorkspaceScope } from "../db/workspace-scope.js";

// KAM-113 (ADR-0028, KAM-203): the hosted `StateStore`, over the `state_entries` table. It is bound to ONE
// workspace and every operation runs inside `withWorkspaceScope`, so the database's FORCE RLS policy
// (drizzle/0013_enable_state_entries_rls.sql) scopes it as well as the `workspace_id` in each statement:
// two workspaces using the same key never see each other's entry. Same contract as the SQLite store (the
// shared suite in packages/engine/test/unit/state-store-contract.ts runs against both), including an
// atomic `putIfAbsent` that gives exactly one of any number of concurrent callers the win, across replicas:
// the insert-or-take-over-an-expired-row is one statement and Postgres row-locks the conflicting key.
//
// Expiry is epoch milliseconds from an injectable clock, as in the SQLite store. `close()` is a no-op: the
// connection pool belongs to the server, not to a run that opened its store through `openState`.

export class PgStateStore implements StateStore {
  private readonly now: StateClock;

  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
    options: { clock?: StateClock } = {},
  ) {
    this.now = options.clock ?? Date.now;
  }

  private expiry(options?: PutOptions): number | null {
    return options?.ttlMs === undefined ? null : this.now() + options.ttlMs;
  }

  async get<T = StateValue>(key: string): Promise<T | undefined> {
    const rows = await withWorkspaceScope(
      this.db,
      this.workspaceId,
      async (tx) =>
        (
          await tx.execute(
            sql`SELECT value FROM state_entries
                WHERE workspace_id = ${this.workspaceId} AND key = ${key}
                  AND (expires_at IS NULL OR expires_at > ${this.now()})`,
          )
        ).rows as Array<{ value: T }>,
    );
    return rows.length === 0 ? undefined : rows[0]!.value;
  }

  async put(key: string, value: StateValue, options?: PutOptions): Promise<void> {
    await withWorkspaceScope(this.db, this.workspaceId, (tx) =>
      tx.execute(
        sql`INSERT INTO state_entries (workspace_id, key, value, expires_at)
            VALUES (${this.workspaceId}, ${key}, ${JSON.stringify(value)}::jsonb, ${this.expiry(options)})
            ON CONFLICT (workspace_id, key)
            DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      ),
    );
  }

  async exists(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  async delete(key: string): Promise<boolean> {
    const rows = await withWorkspaceScope(
      this.db,
      this.workspaceId,
      async (tx) =>
        (
          await tx.execute(
            sql`DELETE FROM state_entries
                WHERE workspace_id = ${this.workspaceId} AND key = ${key}
                RETURNING expires_at`,
          )
        ).rows as Array<{ expires_at: string | null }>,
    );
    // An expired row is removed too (so it is not left behind) but does not count as a live removal.
    const row = rows[0];
    return row !== undefined && (row.expires_at === null || Number(row.expires_at) > this.now());
  }

  async putIfAbsent(key: string, value: StateValue, options?: PutOptions): Promise<boolean> {
    const rows = await withWorkspaceScope(
      this.db,
      this.workspaceId,
      async (tx) =>
        (
          await tx.execute(
            sql`INSERT INTO state_entries (workspace_id, key, value, expires_at)
                VALUES (${this.workspaceId}, ${key}, ${JSON.stringify(value)}::jsonb, ${this.expiry(options)})
                ON CONFLICT (workspace_id, key)
                DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
                WHERE state_entries.expires_at IS NOT NULL AND state_entries.expires_at <= ${this.now()}
                RETURNING key`,
          )
        ).rows,
    );
    return rows.length > 0;
  }

  async list<T = StateValue>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    // left() compare, not LIKE (no wildcard escaping, case-sensitive); byte order like the SQLite store.
    const rows = await withWorkspaceScope(
      this.db,
      this.workspaceId,
      async (tx) =>
        (
          await tx.execute(
            sql`SELECT key, value FROM state_entries
                WHERE workspace_id = ${this.workspaceId}
                  AND left(key, ${prefix.length}) = ${prefix}
                  AND (expires_at IS NULL OR expires_at > ${this.now()})
                ORDER BY key COLLATE "C"`,
          )
        ).rows as Array<{ key: string; value: T }>,
    );
    return rows.map((r) => ({ key: r.key, value: r.value }));
  }

  async close(): Promise<void> {
    // The pool is the server's; nothing to release.
  }
}
