import { describeItem, failedItems } from "./runErrors.js";
import { baseStepName, type NodeRunStatus, type RunTracker } from "./runStatus.js";

// The rows of the bottom run log (KAM-243), read off one run's tracker: a row per step, and per item for the steps
// inside a loop. The engine does not report what a step was handed, so a row's Input is the data it could read:
// the run's input, the results of the steps that ran before it, and the loop item when a failure names it.

export interface LogRow {
  /** The engine's name for the step (`loop[1].fetch` inside a loop), unique within a run. */
  id: string;
  /** The step's own name, without the loop it ran in. */
  step: string;
  label: string;
  /** How many loops it sits inside. */
  depth: number;
  status: NodeRunStatus;
  durationMs?: number;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
}

const ITEM = /\[(\d+)\]\./g;

/** The run's input as the run took it: JSON when it is JSON, else the text. */
function parseInput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function buildRunLog(tracker: RunTracker, runInput: string): LogRow[] {
  const state = tracker.state;
  if (!state) return [];
  const over =
    state.status === "completed" || state.status === "failed" || state.status === "rejected";
  const waitingOn =
    state.status === "awaiting_approval" && state.pendingApproval
      ? state.pendingApproval.step
      : null;
  // A loop that carried on past a failed item never reported the step; its output names it.
  const itemFailures = new Map<string, { message: string; item: unknown }>();
  for (const f of failedItems(state.finalOutput)) {
    itemFailures.set(`${f.loop}[${f.index}].${f.step}`, { message: f.message, item: f.item });
  }
  const base: Record<string, unknown> = { input: parseInput(runInput) };
  const rows: LogRow[] = [];
  // A loop's own result arrives when it ends, after its items'; it still reads first, above them.
  const names: string[] = [];
  for (const name of Object.keys(tracker.entries)) {
    const loop = /^(.*)\[\d+\]\.[^[\]]*$/.exec(name)?.[1];
    if (loop !== undefined && loop in tracker.entries && !names.includes(loop)) names.push(loop);
    if (!names.includes(name)) names.push(name);
  }
  for (const name of names) {
    const entry = tracker.entries[name]!;
    const step = baseStepName(name);
    const depth = [...name.matchAll(ITEM)].length;
    const itemFailure = itemFailures.get(name);
    let status: NodeRunStatus;
    let error: string | undefined;
    if (entry.outcome === "failed") {
      status = "failed";
      error = entry.error ?? "The step failed.";
    } else if (entry.outcome === "completed") {
      status = "passed";
    } else if (itemFailure) {
      status = "failed";
      error = itemFailure.message;
    } else if (over) {
      status = "skipped";
    } else if (waitingOn === name || waitingOn === step) {
      status = "waiting";
    } else {
      status = "running";
    }
    const index = /\[(\d+)\]\.[^[\]]*$/.exec(name)?.[1];
    const label =
      index === undefined
        ? step
        : `${step} · ${itemFailure ? describeItem(itemFailure.item) || `#${Number(index) + 1}` : `#${Number(index) + 1}`}`;
    // What ran before this row: everything that finished earlier at the top level, and in the same loop item.
    const scope = name.slice(0, name.length - step.length);
    const input: Record<string, unknown> = { ...base };
    for (const before of rows) {
      if (before.status !== "passed" || name.startsWith(`${before.id}[`)) continue;
      const sameLevel = before.id.slice(0, before.id.length - before.step.length) === scope;
      if (before.depth === 0 || sameLevel) input[before.step] = before.output;
    }
    if (itemFailure && itemFailure.item !== undefined) input["item"] = itemFailure.item;
    rows.push({
      id: name,
      step,
      label,
      depth,
      status,
      ...(entry.startedAt !== undefined &&
        entry.endedAt !== undefined && {
          durationMs: Math.max(0, entry.endedAt - entry.startedAt),
        }),
      input,
      ...(entry.output !== undefined && { output: entry.output }),
      ...(error !== undefined && { error }),
    });
  }
  return rows;
}

/** The row a node on the canvas points at: its failed row first, else its first. */
export function rowForStep(rows: readonly LogRow[], step: string): LogRow | undefined {
  const mine = rows.filter((r) => r.step === step);
  return mine.find((r) => r.status === "failed") ?? mine[0];
}
