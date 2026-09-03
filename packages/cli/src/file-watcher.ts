import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { classifyFileChange, type FileChangeClassification } from "./watch-decision.js";

// Watches the spec file on disk and classifies each change (ADR-0008): the
// server's own write echoing back is ignored, an external change with no
// mutation in flight auto-reloads, and an external change racing a local
// mutation surfaces a conflict instead of silently auto-resolving.

export interface FileWatchEvent {
  type: FileChangeClassification;
  source: string;
}

export class SpecFileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private lastWrittenHash: string | null = null;
  private pendingMutation = false;

  constructor(private readonly path: string) {
    super();
  }

  start(): void {
    this.watcher = watch(this.path, () => this.handleChange());
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
