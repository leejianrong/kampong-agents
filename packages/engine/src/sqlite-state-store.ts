// SQLite-backed StateStore (ADR-0028). Binding choice: the built-in
// `node:sqlite` module. It needs no native addon or WASM build, so it works
// in the exported project's `node:22-slim` Dockerfile (ADR-0010/0022) with no
// extra install step or build toolchain, and adds no dependency. Cost: it is
// still flagged experimental in Node 22/24 (emits an ExperimentalWarning), and
// needs Node >= 22.13 to run without a flag; the repo already requires
// Node >= 22. Revisit if the API changes.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StateClock, PutOptions, StateStore, StateValue } from "./state-store.js";

export const DEFAULT_STATE_DB_PATH = ".kampong/state.db";

export interface SqliteStateStoreOptions {
  /** Database file, or ":memory:". Defaults to .kampong/state.db. */
  path?: string;
  /** Injectable for tests; defaults to Date.now. */
  clock?: StateClock;
}

export class SqliteStateStore implements StateStore {
  private readonly db: DatabaseSync;
  private readonly now: StateClock;

  constructor(options: SqliteStateStoreOptions = {}) {
    const path = options.path ?? DEFAULT_STATE_DB_PATH;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.now = options.clock ?? Date.now;
    this.db = new DatabaseSync(path);
    // Several processes (a poller and a webhook server) may share the file.
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS state (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         expires_at INTEGER
       ) WITHOUT ROWID`,
    );
  }

  private expiry(options?: PutOptions): number | null {
    return options?.ttlMs === undefined ? null : this.now() + options.ttlMs;
  }

  async get<T = StateValue>(key: string): Promise<T | undefined> {
    const row = this.db
      .prepare("SELECT value FROM state WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)")
      .get(key, this.now()) as { value: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value) as T);
  }

  async put(key: string, value: StateValue, options?: PutOptions): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO state (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      )
      .run(key, JSON.stringify(value), this.expiry(options));
  }

  async exists(key: string): Promise<boolean> {
    return (
      this.db
        .prepare("SELECT 1 FROM state WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)")
        .get(key, this.now()) !== undefined
    );
  }

  async delete(key: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM state WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)")
      .run(key, this.now());
    // Also drop an expired row so it is not left behind.
    this.db.prepare("DELETE FROM state WHERE key = ?").run(key);
    return Number(result.changes) > 0;
  }

  async putIfAbsent(key: string, value: StateValue, options?: PutOptions): Promise<boolean> {
    // One statement: insert, or take over an expired row. The WHERE on the
    // conflict branch makes it a no-op (changes = 0) for a live entry, and
    // SQLite serializes writers, so exactly one caller wins across processes.
    const result = this.db
      .prepare(
        `INSERT INTO state (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
         WHERE state.expires_at IS NOT NULL AND state.expires_at <= ?`,
      )
      .run(key, JSON.stringify(value), this.expiry(options), this.now());
    return Number(result.changes) > 0;
  }

  async list<T = StateValue>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    // substr compare, not LIKE: no wildcard escaping, case-sensitive.
    const rows = this.db
      .prepare(
        `SELECT key, value FROM state
         WHERE substr(key, 1, ?) = ? AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY key`,
      )
      .all(prefix.length, prefix, this.now()) as Array<{ key: string; value: string }>;
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) as T }));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
