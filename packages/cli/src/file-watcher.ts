import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { classifyFileChange, type FileChangeClassification } from "./watch-decision.js";

// Watches the spec file on disk and classifies each change (ADR-0008): the
// server's own write echoing back is ignored, an external change with no
// mutation in flight auto-reloads, and an external change racing a local
// mutation surfaces a conflict instead of silently auto-resolving.
//
// KAN-1184: this watches the CONTAINING DIRECTORY, not the spec file's own
// path. `fs.watch(filePath)` is watching an inode, not a filename -- an
// editor's atomic save (write a temp file, then rename() it over the
// original path, which is how Vim, many VS Code configs, and other common
// editors save) replaces the inode at that path. A watch on the old inode
// goes silent forever afterward: it fires once for the rename, then never
// again, even for later plain in-place writes. A directory watch survives
// inode replacement underneath it, since the directory itself isn't
// replaced -- so we watch the directory and filter events down to the one
// filename we care about.

// KAN-1216: a genuine deletion (as opposed to the transient mid-write gap
// this file already tolerated) used to be swallowed by handleChange()'s
// catch-and-return-silently -- the watcher went deaf forever and the canvas
// never found out. `handleChange` now retries once, a tick later, before
// declaring the file genuinely missing -- that one retry is what preserves
// tolerance for a real transient gap (e.g. an editor that unlinks then
// recreates rather than atomically renaming) -- and only THEN emits a
// distinct "missing" event so a live canvas tab can show a real error
// instead of going blank. This is deliberately not a "recover the file"
// feature: once it reappears, the next directory event's successful read
// falls through to the normal self/conflict/reload classification, which is
// how the existing auto-reload machinery (ADR-0008) picks it back up.
const MISSING_FILE_RETRY_DELAY_MS = 50;

export type WatchEventType = FileChangeClassification | "missing";

export interface FileWatchEvent {
  type: WatchEventType;
  source: string;
}

export class SpecFileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private lastWrittenHash: string | null = null;
  private pendingMutation = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly fileName: string;
  private readonly watchDir: string;

  constructor(private readonly path: string) {
    super();
    this.fileName = basename(path);
    this.watchDir = dirname(path);
  }

  start(): void {
    this.watcher = watch(this.watchDir, (_eventType, changedFileName) => {
      // `filename` isn't guaranteed by Node's docs on every platform, but is
      // reliably populated on Linux/macOS/Windows for a same-directory
      // rename/change. If a platform ever omits it, fail open (react to
      // every directory event) rather than silently going deaf again --
      // that's the exact failure mode this fix exists to prevent.
      if (changedFileName !== null && changedFileName !== this.fileName) return;
      this.handleChange();
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Call before validating/writing a canvas-triggered mutation. */
  beginMutation(): void {
    this.pendingMutation = true;
  }

  /** Call once the mutation's write (if any) has completed. */
  endMutation(writtenSource?: string): void {
    this.pendingMutation = false;
    if (writtenSource !== undefined) {
      this.lastWrittenHash = hash(writtenSource);
    }
  }

  private handleChange(isRetry = false): void {
    let source: string;
    try {
      source = readFileSync(this.path, "utf8");
    } catch {
      // The file can be transiently missing mid-write on some platforms/
      // editors -- give it one retry a tick later before treating this as a
      // genuine deletion, rather than declaring it missing on the very
      // first failed read.
      if (!isRetry) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.handleChange(true);
        }, MISSING_FILE_RETRY_DELAY_MS);
        return;
      }
      this.emit("change", { type: "missing", source: "" } satisfies FileWatchEvent);
      return;
    }

    const newHash = hash(source);
    const classification = classifyFileChange({
      pendingMutation: this.pendingMutation,
      lastWrittenHash: this.lastWrittenHash,
      newHash,
    });

    if (classification === "self") return;
    this.emit("change", { type: classification, source } satisfies FileWatchEvent);
  }
}

function hash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
