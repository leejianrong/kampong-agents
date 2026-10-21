import type { RunState } from "./api.js";
import { failedItems } from "./runErrors.js";

// One run in a word, an icon and a colour role (KAM-219): the run bar's status chip and the runs drawer both draw
// from this, so a run is called the same thing in both. A run that finished with failed items carried on past is
// "completed with errors", a warning, never "completed".

export type RunSummaryKind =
  "running" | "awaiting_approval" | "completed" | "completed_with_errors" | "failed" | "rejected";

export interface RunSummary {
  kind: RunSummaryKind;
  /** The words, for the screen and for a screen reader. */
  label: string;
  /** A glyph drawn beside the words (hidden from a screen reader: the label says it). */
  icon: string;
  /** How many failed items a completed run carried on past. */
  errors: number;
}

const ICON: Record<RunSummaryKind, string> = {
  running: "↻",
  awaiting_approval: "⏸",
  completed: "✓",
  completed_with_errors: "!",
  failed: "✕",
  rejected: "✕",
};

export function summarizeRun(state: RunState): RunSummary {
  const errors = state.status === "completed" ? failedItems(state.finalOutput).length : 0;
  const kind: RunSummaryKind = errors > 0 ? "completed_with_errors" : state.status;
  const label =
    kind === "completed_with_errors"
      ? `completed with ${errors} ${errors === 1 ? "error" : "errors"}`
      : kind === "awaiting_approval"
        ? "waiting for approval"
        : kind;
  return { kind, label, icon: ICON[kind], errors };
}

/** A run's length as people read it: "0.4 s", "12 s", "2 min 5 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
