import type { NodeRunInfo } from "./runStatus.js";

// KAM-241 (ADR-0059 §5): a line shows what the run did along it. It takes the state of the step it leads into: that
// step passed (green), failed (red) or is still going (animated). The count is how many times that step ran, which
// inside a loop is how many items reached it; outside a loop it is 1. A step that never ran, or was skipped, leaves
// its line idle. The state is always written as well as coloured.

export type EdgeRunState = "passed" | "failed" | "running";

export interface EdgeRun {
  state: EdgeRunState;
  count: number;
}

export function edgeRun(target: NodeRunInfo | undefined): EdgeRun | undefined {
  if (!target) return undefined;
  const count = target.runs ?? 1;
  switch (target.status) {
    case "passed":
      return { state: "passed", count };
    case "failed":
      return { state: "failed", count };
    case "running":
    case "waiting":
      return { state: "running", count };
    default:
      return undefined;
  }
}

const itemsWord = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

/** What the line says in words, for its tooltip and its accessible name. */
export function edgeRunText(run: EdgeRun): string {
  if (run.state === "running") return "Running";
  if (run.state === "passed") return `Passed, ${itemsWord(run.count)}`;
  // A loop's step that ran for several items and failed did not necessarily fail for each of them.
  return run.count > 1 ? `Failed for at least one of ${run.count} items` : "Failed, 1 item";
}

/** What the pill on the line shows: an icon, then the count. */
export function edgeRunPill(run: EdgeRun): string {
  return run.state === "running" ? "↻" : `${run.state === "passed" ? "✓" : "✕"} ${run.count}`;
}
