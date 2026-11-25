// KAM-324: the shapes the dashboard reads for a spec's runs, and the one sentence that says how a run ended.

export interface RunListItem {
  id: string;
  status: string;
  source: string;
  triggeredBy: string | null;
  startedAt: string;
  completedAt: string | null;
  /** One short sentence for the list: what happened, in plain words. */
  outcome: string;
  /** Estimated cost in US dollars; null until the run ends and records its usage (KAM-325). */
  costUsd: number | null;
}

export interface PendingApprovalItem {
  runId: string;
  startedAt: string;
  /** Null when the run is waiting on another replica, which holds the detail (KAM-348). */
  step: string | null;
  reason: string | null;
}

export const DEFAULT_RUN_LIST_LIMIT = 20;
export const MAX_RUN_LIST_LIMIT = 100;

/** `?limit=` as a number: missing or unreadable is the default, and anything else is kept within 1 to the maximum. */
export function parseRunListLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_RUN_LIST_LIMIT;
  return Math.min(MAX_RUN_LIST_LIMIT, Math.max(1, Math.floor(n)));
}

/** How a run ended, for the list: the first line of an error, or the plain name of its status. */
export function describeOutcome(status: string, error: string | null): string {
  switch (status) {
    case "running":
      return "Running";
    case "awaiting_approval":
      return "Waiting for approval";
    case "completed":
      return "Finished";
    case "rejected":
      return "Rejected";
    case "failed": {
      const line = error
        ?.split("\n")
        .find((l) => l.trim() !== "")
        ?.trim();
      if (!line) return "Failed";
      return line.length > 120 ? `${line.slice(0, 119)}…` : line;
    }
    default:
      return status;
  }
}
