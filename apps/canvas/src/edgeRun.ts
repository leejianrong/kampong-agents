import type { NodeRunInfo } from "./runStatus.js";

// KAM-241 (ADR-0059 §5): a line shows what the run did along it. It takes the state of the step it leads into: that
// step passed (green), failed (red) or is still going (animated). The count is how many times that step ran, which
// inside a loop is how many items reached it; outside a loop it is 1. A step that never ran, or was skipped, leaves
// its line idle. The state is always written as well as coloured.

export type EdgeRunState = "passed" | "failed" | "running";

export interface EdgeRun {
  state: EdgeRunState;
  count: number;
  /** For a failed step that ran for several items: how many of them failed (KAM-300). */
  failures?: number;
}

export function edgeRun(target: NodeRunInfo | undefined): EdgeRun | undefined {
  if (!target) return undefined;
  const count = target.runs ?? 1;
  switch (target.status) {
    case "passed":
      return { state: "passed", count };
    case "failed":
      return {
        state: "failed",
        count,
        ...(target.failures !== undefined &&
          target.failures < count && { failures: target.failures }),
      };
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
  if (run.failures !== undefined) return `${run.failures} of ${itemsWord(run.count)} failed`;
  return run.count > 1 ? `Failed, all ${run.count} items` : "Failed, 1 item";
}

/** What the pill on the line shows: an icon, then the count. */
export function edgeRunPill(run: EdgeRun): string {
  if (run.state === "running") return "↻";
  if (run.state === "passed") return `✓ ${run.count}`;
  return run.failures !== undefined ? `✕ ${run.failures} of ${run.count}` : `✕ ${run.count}`;
}
