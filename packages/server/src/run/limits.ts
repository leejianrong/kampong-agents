// KAM-323: what one workspace may use of the shared server. Three limits, each checked or enforced in the run manager:
//   - concurrent runs: runs in the `running` state at once. Over it, a start is refused with 429 and a stated reason.
//   - runs per calendar month (UTC): over it, the workspace's deployments are paused with a reason the panel shows,
//     and a start is refused.
//   - run time: a run that keeps running past it is stopped and recorded as failed with that reason.
// 0 turns a limit off. The defaults suit a labelled preview on one machine; an operator raises them in the chart.
// The limits are the same for every workspace for now; a per-workspace override would be a column when a customer
// needs one.

export interface RunLimits {
  maxConcurrent: number;
  maxPerMonth: number;
  maxRuntimeMs: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxConcurrent: 5,
  maxPerMonth: 3000,
  maxRuntimeMs: 15 * 60_000,
};

/** A start refused for a limit. `code` says which, so a route can answer and a deployment can say why it paused. */
export class RunLimitError extends Error {
  constructor(
    public readonly code: "concurrency" | "monthly",
    public readonly limit: number,
  ) {
    super(
      code === "concurrency"
        ? `This workspace already has ${limit} runs going, which is its limit. Try again when one finishes.`
        : `This workspace has used its ${limit} runs for the month. Its deployments are paused until the limit is raised or the month turns over.`,
    );
    this.name = "RunLimitError";
  }
}

/** The reason stored on a deployment the system paused. */
export const PAUSED_FOR_MONTHLY_LIMIT = "monthly_limit";
