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

export interface FileWatchEvent {
  type: FileChangeClassification;
  source: string;
}

export class SpecFileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private lastWrittenHash: string | null = null;
  private pendingMutation = false;
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

  private handleChange(): void {
    let source: string;
    try {
      source = readFileSync(this.path, "utf8");
    } catch {
      // The file can be transiently missing mid-write on some platforms/editors.
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
