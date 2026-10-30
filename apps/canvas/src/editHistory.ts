import type { ApiClient } from "./api.js";

// KAM-183 (ADR-0062): undo and redo for the edits made in this session. One stack of snapshots, the same in local
// mode (a file on disk) and hosted mode (a spec row): a snapshot is the spec's text exactly as it was (comments and
// formatting included, because the text is what is kept, never a re-serialised object) plus the layout map, so
// undoing a drag-pin or a step move puts the cards back too. Restoring goes through `replaceSource` and
// `pinPositions`, the two writes both servers already have, so the modes cannot drift. Nothing here touches React.

/** The layout as the server returns it: the client type carries x and y, the stored entries also say `pinned`. */
export type LayoutMap = Record<string, { x: number; y: number; pinned?: boolean }>;

export interface Snapshot {
  source: string;
  layout: LayoutMap;
}

/** How many edits Undo can walk back. The oldest falls off first; a snapshot is a few kilobytes of text. */
export const HISTORY_DEPTH = 100;

/** How long after its own write the canvas treats a file change as probably its own echo. */
const ECHO_MS = 1500;

const LAYOUT_MARK = "$layout";

export class EditHistory {
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private listeners = new Set<() => void>();
  private writes = 0;
  private restoring = false;
  /** Bumps on every change, for `useSyncExternalStore`. */
  version = 0;
  /**
   * The revision the server gave for the last write made here. A restore sends it as `baseRevision`, so it is
   * refused (stale) when the file has changed since, rather than throwing a later edit away.
   */
  revision: string | undefined;

  constructor(private readonly depth = HISTORY_DEPTH) {}

  get undoCount(): number {
    return this.past.length;
  }
  get redoCount(): number {
    return this.future.length;
  }
  /** A write or a restore is in flight: its result is not known, so a restore would read a stale "now". */
  get busy(): boolean {
    return this.writes > 0 || this.restoring;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getVersion = (): number => this.version;

  private changed(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /** A write is starting or has finished (a count, so overlapping writes are held until all are done). */
  writing(delta: 1 | -1): void {
    this.writes += delta;
    if (delta < 0) this.echoUntil = Date.now() + ECHO_MS;
    this.release();
  }
  restoringNow(on: boolean): void {
    this.restoring = on;
    if (!on) this.echoUntil = Date.now() + ECHO_MS;
    this.release();
  }

  private echoUntil = 0;
  /**
   * The file watcher can report this client's own save before the canvas has reloaded it, so a change seen while a
   * write is in flight, or just after one, is not taken for an outside edit. If an outside edit hides in that
   * window the stack stays, and the revision check still refuses a restore over it.
   */
  get ownWriteLikely(): boolean {
    return this.busy || Date.now() < this.echoUntil;
  }

  /** A load that finds nothing to depend on adopts the server's revision, so the first restore is guarded. */
  seedRevision(revision: string | undefined): void {
    if (revision !== undefined && this.past.length === 0 && this.future.length === 0) {
      this.revision = revision;
    }
  }

  private waiting: (() => void)[] = [];
  private release(): void {
    if (this.busy) return;
    const waiters = this.waiting;
    this.waiting = [];
    for (const wake of waiters) wake();
  }
  /**
   * Resolves once no write or restore is in flight. A Ctrl+Z pressed a moment after a drop waits for the drop's
   * save to land rather than being dropped; the caller re-checks `busy` after waking, since another waiter may
   * have started first.
   */
  idle(): Promise<void> {
    return this.busy ? new Promise((resolve) => this.waiting.push(resolve)) : Promise.resolve();
  }

  /** A new edit: `before` is what the spec was. It ends the redo chain, as in any editor. */
  record(before: Snapshot, revision?: string): void {
    // The workflow did not exist (or was empty text): there is nothing to go back to.
    if (before.source.trim() === "") return;
    this.past.push(before);
    if (this.past.length > this.depth) this.past.shift();
    this.future = [];
    if (revision !== undefined) this.revision = revision;
    this.changed();
  }

  peekUndo(): Snapshot | undefined {
    return this.past[this.past.length - 1];
  }
  peekRedo(): Snapshot | undefined {
    return this.future[this.future.length - 1];
  }

  /** The undo the caller just restored: `current` is what the spec was before it, which Redo returns to. */
  commitUndo(current: Snapshot, revision?: string): void {
    this.past.pop();
    this.future.push(current);
    if (revision !== undefined) this.revision = revision;
    this.changed();
  }
  commitRedo(current: Snapshot, revision?: string): void {
    this.future.pop();
    this.past.push(current);
    if (revision !== undefined) this.revision = revision;
    this.changed();
  }

  /** The file changed outside the canvas: nothing in the stack is safe to restore. */
  clear(): boolean {
    const had = this.past.length > 0 || this.future.length > 0;
    this.past = [];
    this.future = [];
    this.revision = undefined;
    if (had) this.changed();
    return had;
  }
}

const pinnedOf = (layout: LayoutMap) =>
  Object.entries(layout).filter(([id, at]) => id !== LAYOUT_MARK && at.pinned === true);

/** The pins to send so the stored layout becomes `target`'s: set the ones it has, unpin the ones it lacks. */
export function pinDiff(
  current: LayoutMap,
  target: LayoutMap,
): Record<string, { x: number; y: number } | null> {
  const diff: Record<string, { x: number; y: number } | null> = {};
  const now = new Map(pinnedOf(current));
  const then = new Map(pinnedOf(target));
  for (const [id, at] of then) {
    const was = now.get(id);
    if (!was || was.x !== at.x || was.y !== at.y) diff[id] = { x: at.x, y: at.y };
  }
  for (const id of now.keys()) if (!then.has(id)) diff[id] = null;
  return diff;
}

export type RestoreResult =
  | { ok: true; revision?: string }
  | {
      ok: false;
      stale: boolean;
      messages: string[];
      /** The text was already put back before the positions failed: the caller must treat the spec as changed. */
      textWritten?: { revision?: string };
    };

type RestoreApi = Pick<ApiClient, "replaceSource"> & Partial<Pick<ApiClient, "pinPositions">>;

/**
 * Puts the spec back to `target`: the text first (refused when `baseRevision` is out of date, nothing written),
 * then the pinned positions, when the snapshot has a layout. The one restore both Undo/Redo and the assistant's
 * Undo (KAM-250) use. A text that no longer validates is refused by the server like any import.
 */
export async function restoreSnapshot(
  api: RestoreApi,
  target: { source: string; layout?: LayoutMap },
  current: Snapshot | undefined,
  baseRevision?: string,
): Promise<RestoreResult> {
  let revision: string | undefined;
  // `current` unknown: the text is always written (the assistant's Undo has no snapshot of what is on screen).
  if (current === undefined || target.source !== current.source) {
    const result = await api.replaceSource(target.source, {
      ...(baseRevision !== undefined && { baseRevision }),
    });
    if (!result.success) {
      return {
        ok: false,
        stale: result.stale === true,
        messages: (result.errors ?? []).map((e) => e.message),
      };
    }
    revision = result.revision;
  }
  if (target.layout && current && api.pinPositions) {
    const diff = pinDiff(current.layout, target.layout);
    if (Object.keys(diff).length > 0) {
      const pinned = await api.pinPositions(diff);
      if (!pinned.success) {
        return {
          ok: false,
          stale: false,
          messages: [pinned.error ?? "Could not restore positions."],
          ...(current === undefined || target.source !== current.source
            ? { textWritten: { ...(revision !== undefined && { revision }) } }
            : {}),
        };
      }
    }
  }
  return { ok: true, ...(revision !== undefined && { revision }) };
}

/**
 * The client with every write recorded: wraps the calls that change the spec or its layout, so any edit (a form, a
 * drop, an import, the assistant's Apply) lands on the stack without each handler knowing. Reads and runs pass
 * through. Writes run one at a time, and each one's "before" is read from the server when its turn comes, so it is
 * the text the previous write left, not what the screen has caught up with. A drop that moves nothing is not an edit.
 */
export function withHistory(
  raw: ApiClient,
  history: EditHistory,
  snapshot: () => Snapshot,
): ApiClient {
  let tail: Promise<unknown> = Promise.resolve();
  async function stored(): Promise<Snapshot> {
    try {
      const fresh = await raw.loadSpec();
      if (typeof fresh?.source === "string") {
        return { source: fresh.source, layout: (fresh.layout ?? {}) as LayoutMap };
      }
    } catch {
      // the screen's copy is the best there is
    }
    return snapshot();
  }
  function recorded<T extends { success: boolean; revision?: string; layout?: unknown }>(
    run: () => Promise<T>,
    isEdit: (before: Snapshot, result: T) => boolean = () => true,
  ): Promise<T> {
    history.writing(1);
    const turn = tail.then(async () => {
      try {
        const before = await stored();
        const result = await run();
        if (result.success && isEdit(before, result)) history.record(before, result.revision);
        return result;
      } finally {
        history.writing(-1);
      }
    });
    tail = turn.catch(() => undefined);
    return turn;
  }
  const wrapped: ApiClient = {
    ...raw,
    applyPatch: (ops) => recorded(() => raw.applyPatch(ops)),
    applyOps: (ops, options) => recorded(() => raw.applyOps(ops, options)),
    replaceSource: (source, options) => recorded(() => raw.replaceSource(source, options)),
    pinPositions: (positions) =>
      recorded(
        () => raw.pinPositions(positions),
        (before, result) =>
          result.layout === undefined ||
          Object.keys(pinDiff(before.layout, result.layout as LayoutMap)).length > 0,
      ),
    startBlank: () => recorded(() => raw.startBlank()),
  };
  if (raw.startFromTemplate) {
    const start = raw.startFromTemplate.bind(raw);
    wrapped.startFromTemplate = (name, options) => recorded(() => start(name, options));
  }
  return wrapped;
}
