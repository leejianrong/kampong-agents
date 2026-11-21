import type { RunState } from "./api.js";
import type { LogRow } from "./runLog.js";
import { finishedWithFailures } from "./runSummary.js";

// ADR-0063 / KAM-269: the answer to "what happened?" in a line or two of plain words, read off the run and its log
// rows. The run log leads with it; the step list and the data are one click below.

export interface Outcome {
  tone: "ok" | "warn" | "error" | "wait" | "run";
  headline: string;
  /** One more line: what failed and why, or what is waiting. */
  detail?: string;
}

/** Keeps a long error (a provider's whole notice) to a line; the step's Error tab has the full text. */
export const oneLine = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

const quoted = (row: LogRow): string => `"${row.label}"`;

export function outcomeOf(state: RunState, rows: readonly LogRow[]): Outcome {
  const failed = rows.filter((r) => r.status === "failed");
  const first = failed[0];
  switch (state.status) {
    case "running":
      return { tone: "run", headline: "Running…" };
    case "awaiting_approval":
      return {
        tone: "wait",
        headline: "Waiting for your approval",
        ...(state.pendingApproval && {
          detail: `Step "${state.pendingApproval.step}" needs a decision before the run goes on.`,
        }),
      };
    case "rejected":
      return {
        tone: "warn",
        headline: "Stopped: you rejected it",
        ...(state.pendingApproval && {
          detail: `Step "${state.pendingApproval.step}" was not approved.`,
        }),
      };
    case "failed": {
      const reason = first?.error ?? state.error;
      return {
        tone: "error",
        headline: first ? `Stopped at ${quoted(first)}` : "The run stopped",
        ...(reason && { detail: oneLine(reason) }),
      };
    }
    default: {
      if (failed.length > 0 && first) {
        return {
          tone: "warn",
          headline: finishedWithFailures(failed.length),
          detail: `The run carried on. First: ${quoted(first)}${first.error ? `: ${oneLine(first.error)}` : "."}`,
        };
      }
      const steps = rows.filter((r) => r.depth === 0 && r.status === "passed").length;
      return {
        tone: "ok",
        headline: "Finished, everything worked",
        ...(steps > 0 && { detail: `${steps} ${steps === 1 ? "step" : "steps"} ran.` }),
      };
    }
  }
}
