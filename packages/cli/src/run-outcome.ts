import type { RunState, Span, Trace } from "@kampong/engine";

// KAM-309: a run's outcome in one plain sentence, for `kampong serve`'s log and its GET /runs. A scheduled or webhook
// run has nobody watching it, so the line has to say what happened and, when something failed, what first went
// wrong, in words and without the raw HTTP dump a provider's error can carry.

export interface Outcome {
  /** One sentence: what happened. */
  text: string;
  /** `ok`: it all worked. `partial`: it finished but some steps failed. `failed`: nothing useful came of it. */
  kind: "running" | "waiting" | "ok" | "partial" | "failed" | "rejected";
  failedSteps: number;
  steps: number;
}

/** The first line of an error, squeezed to one line and cut short; the full text stays on the run. */
export function oneLine(message: string | undefined, max = 160): string {
  const first = (message ?? "").split("\n").find((l) => l.trim() !== "") ?? "";
  const flat = first.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const inItem = (step: string) => /\[\d+\]/.test(step);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What the outcome counts: the steps and tools that did work. A loop, a branch and a model call are not steps. */
const NOT_A_STEP: ReadonlySet<Span["kind"]> = new Set(["run", "foreach", "branch", "model"]);

/**
 * `trace` (the run's span tree) is what knows about a loop item that failed and was carried past (`on_error:
 * continue`): the run's own step list holds only what completed. Without it, the step list is used.
 */
export function describeOutcome(state: RunState, trace?: Trace): Outcome {
  const work = trace
    ? trace.spans
        .filter((s) => !NOT_A_STEP.has(s.kind))
        .map((s) => ({ step: s.name, failed: s.status === "error", error: s.error }))
    : state.trace.map((s) => ({ step: s.step, failed: s.status === "failed", error: s.error }));
  const steps = work.length;
  const failed = work.filter((s) => s.failed);
  const first = failed[0];
  const firstText = first ? ` First: ${first.step}: ${oneLine(first.error) || "no message"}` : "";
  const base = { failedSteps: failed.length, steps };

  switch (state.status) {
    case "running":
      return { ...base, kind: "running", text: "running" };
    case "awaiting_approval":
      return {
        ...base,
        kind: "waiting",
        text: `waiting for approval${state.pendingApproval ? ` at "${state.pendingApproval.step}"` : ""}`,
      };
    case "rejected":
      return {
        ...base,
        kind: "rejected",
        text: `rejected${state.error ? `: ${oneLine(state.error)}` : ""}`,
      };
    case "failed":
      return { ...base, kind: "failed", text: `failed: ${oneLine(state.error) || "no message"}` };
    default: {
      if (failed.length === 0) {
        const early = state.skipped
          ? `ended early at ${state.skipped.step}: ${oneLine(state.skipped.reason)}`
          : `completed, ${plural(steps, "step")}`;
        return { ...base, kind: "ok", text: early };
      }
      // Items of a loop that all failed leave the run "completed" (on_error: continue), which reads as success.
      const items = work.filter((s) => inItem(s.step));
      const nothingWorked = items.length > 0 && items.every((s) => s.failed);
      if (nothingWorked) {
        return {
          ...base,
          kind: "failed",
          text: `finished, but nothing worked: every item failed (${plural(failed.length, "failure")}).${firstText}`,
        };
      }
      return {
        ...base,
        kind: "partial",
        text: `finished, ${failed.length} of ${plural(steps, "step")} failed.${firstText}`,
      };
    }
  }
}
