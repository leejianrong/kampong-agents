// The one nuance in the file-watcher (ADR-0008, Q10): most external changes
// should auto-reload with no prompt, but a local mutation in flight when an
// external write lands is a genuine conflict and needs a prompt instead.
// Kept as a pure function, independent of any real file I/O or timing, so
// it's deterministically testable rather than relying on flaky real-world
// file-watch timing in tests.

export type FileChangeClassification = "self" | "conflict" | "reload";

export interface ClassifyFileChangeInput {
  /** True while a PUT /api/spec request from the canvas is being validated/written. */
  pendingMutation: boolean;
  /** Content hash of what this process itself last wrote to disk, if any. */
  lastWrittenHash: string | null;
  /** Content hash of the file as it now stands on disk. */
  newHash: string;
}

export function classifyFileChange({
  pendingMutation,
  lastWrittenHash,
  newHash,
}: ClassifyFileChangeInput): FileChangeClassification {
  if (lastWrittenHash !== null && newHash === lastWrittenHash) {
    // The change is this process's own write echoing back through the
    // watcher — not a real external edit.
    return "self";
  }
  if (pendingMutation) {
    // A canvas mutation was mid-flight (validated but not yet flushed) when
    // this external write landed — the one case ADR-0008 does NOT
    // auto-resolve.
    return "conflict";
  }
  return "reload";
}
