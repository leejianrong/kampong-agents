// Vendored from packages/engine/src/state-store.ts as part of a `kampong export`
// -- see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. It is
// copied unchanged. From here on this file is yours: it will not be touched
// again by a future export.
//
// StateStore (ADR-0028, KAM-112): a small durable keyed store for runtime
// state that outlives a request -- pending approvals, poll cursors, dedupe
// keys, overlap locks. Runtime state only; the spec YAML stays the source of
// truth (ADR-0002). The interface is async so the hosted Postgres
// implementation (a later V11 card) can satisfy it unchanged; the shared
// contract suite in test/unit/state-store-contract.ts is what both must pass.

export type StateValue = unknown; // anything JSON-serializable

export interface PutOptions {
  /** Time to live in milliseconds from now. Omit for no expiry. */
  ttlMs?: number;
}

export interface StateStore {
  /** The value, or undefined if absent or expired. */
  get<T = StateValue>(key: string): Promise<T | undefined>;
  /** Insert or overwrite. Overwriting without ttlMs clears any prior expiry. */
  put(key: string, value: StateValue, options?: PutOptions): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Returns true if a live entry was removed. */
  delete(key: string): Promise<boolean>;
  /**
   * Atomic insert-if-absent (an expired entry counts as absent). Returns true
   * for exactly one of any number of concurrent callers on the same key.
   */
  putIfAbsent(key: string, value: StateValue, options?: PutOptions): Promise<boolean>;
  /** Live entries whose key starts with `prefix`, ordered by key. */
  list<T = StateValue>(prefix: string): Promise<Array<{ key: string; value: T }>>;
  close(): Promise<void>;
}

export type StateClock = () => number;
