import type { RunState } from "./api.js";
import type { LogRow } from "./runLog.js";
import { explainError } from "./runReason.js";
import { loopTotals, nothingWorked } from "./runErrors.js";
import { finishedWithFailures, nothingWorkedLabel } from "./runSummary.js";

// ADR-0063 / KAM-269: the answer to "what happened?" in a line or two of plain words, read off the run and its log
// rows. The run log leads with it; the step list and the data are one click below.

export interface Outcome {
  tone: "ok" | "warn" | "error" | "wait" | "run";
  headline: string;
  /** One more line: what failed and why, or what is waiting. */
  detail?: string;
  /** A hint after it, for something the person may not know to look for. */
  note?: string;
}

export interface OutcomeExtras {
  /** Approval steps the run went past without stopping (KAM-283). */
  skippedApprovals?: readonly string[];
  /** The workflow has vars to change. */
  hasVars?: boolean;
}

/** Said when a finished run never stopped for an approval, so the trust feature is not invisible (KAM-283). */
function skippedNote(extras: OutcomeExtras): string | undefined {
  const names = extras.skippedApprovals ?? [];
  if (names.length === 0) return undefined;
  const which =
    names.length === 1 ? `The approval step "${names[0]}"` : `${names.length} approval steps`;
  return `${which} did not ask: nothing in this run needed a person.${
    extras.hasVars ? " Change a value under Vars to see it." : ""
  }`;
}

/** Keeps a long error (a provider's whole notice) to a line; the step's Error tab has the full text. */
export const oneLine = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** A failure as one plain line: the headline when the message is a known kind, else the message cut short. */
const reasonLine = (message: string): string => {
  const r = explainError(message);
  return r.known ? r.headline : oneLine(message);
};

/** "2 steps ran." and, when a loop went through items, how many: the top-level steps are not the whole of the work. */
function stepsRan(steps: number, items: number): string {
  const base = `${steps} ${steps === 1 ? "step" : "steps"} ran`;
  return items > 0
    ? `${base}, going through ${items} ${items === 1 ? "item" : "items"}.`
    : `${base}.`;
}

const quoted = (row: LogRow): string => `"${row.label}"`;

export function outcomeOf(
  state: RunState,
  rows: readonly LogRow[],
  extras: OutcomeExtras = {},
): Outcome {
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
        ...(reason && { detail: reasonLine(reason) }),
      };
    }
    default: {
      const note = skippedNote(extras);
      if (failed.length > 0 && first && nothingWorked(state.finalOutput)) {
        // Every item failed: a failed run in words, with the reason when it was the same for all.
        const reasons = new Set(failed.map((r) => reasonLine(r.error ?? "The step failed.")));
        const [only] = [...reasons];
        return {
          ...(note !== undefined && { note }),
          tone: "error",
          headline: nothingWorkedLabel(failed.length).replace(", all", ": all"),
          detail:
            reasons.size === 1 && only
              ? `Every one failed the same way: ${only}`
              : `First: ${quoted(first)}${first.error ? `: ${reasonLine(first.error)}` : "."}`,
        };
      }
      if (failed.length > 0 && first) {
        return {
          ...(note !== undefined && { note }),
          tone: "warn",
          headline: finishedWithFailures(failed.length, loopTotals(state.finalOutput).total),
          detail: `The run carried on. First: ${quoted(first)}${first.error ? `: ${reasonLine(first.error)}` : "."}`,
        };
      }
      const steps = rows.filter((r) => r.depth === 0 && r.status === "passed").length;
      return {
        tone: "ok",
        headline: "Finished, everything worked",
        ...(note !== undefined && { note }),
        ...(steps > 0 && { detail: stepsRan(steps, loopTotals(state.finalOutput).total) }),
      };
    }
  }
}
