import type { RunEventMessage, RunState } from "./api.js";
import { failedItems } from "./runErrors.js";
import { missingSecretNames } from "./secretNames.js";

// What a run did to each step, read off the run's event stream (KAM-190). The canvas draws it on the nodes, and
// the run bar (KAM-219) and the data picker (KAM-218) read the same record: each step's status, its last output
// and how long it took. Nothing here touches the spec or the saved layout; it is a view of one run.

export type NodeRunStatus = "running" | "waiting" | "passed" | "failed" | "skipped";

/** What one canvas node shows for the run on screen. */
export interface NodeRunInfo {
  status: NodeRunStatus;
  /** Why it failed, or was rejected: the same text the run panel shows. */
  message?: string;
  /** The step's last output (inside a foreach, the last item's). */
  output?: unknown;
  /** How long the step took in this browser's clock, from its start event to its result. */
  durationMs?: number;
  /** Inside a foreach: how many times the step ran. */
  runs?: number;
  /** Inside a foreach: how many of those runs failed. */
  failures?: number;
}

interface StepEntry {
  startedAt?: number;
  endedAt?: number;
  outcome?: "completed" | "failed";
  output?: unknown;
  error?: string;
}

/** Everything the stream has said about one run, by the step name the engine used (`loop[0].inner` in a loop). */
export interface RunTracker {
  runId: string | null;
  entries: Record<string, StepEntry>;
  /** The latest run state: its status says whether the run is over, and a pending approval says what waits. */
  state: RunState | null;
}

export const emptyTracker: RunTracker = { runId: null, entries: {}, state: null };

/** The step a (possibly loop-qualified) engine name belongs to: `loop[2].inner` is `inner`. */
export function baseStepName(name: string): string {
  return name.replace(/^.*\]\./, "");
}

/** Folds one stream message (or the POST's first state) into the tracker; a message for another run is ignored. */
export function applyMessage(
  tracker: RunTracker,
  runId: string,
  message: RunEventMessage,
  now: number,
): RunTracker {
  if (tracker.runId !== runId) return tracker;
  const entries = { ...tracker.entries };
  // The state carries every finished step, so a start missed before the stream opened costs only its timing.
  for (const record of message.state.trace) {
    const had = entries[record.step];
    if (had?.outcome) continue;
    entries[record.step] = {
      ...had,
      endedAt: now,
      outcome: record.status === "completed" ? "completed" : "failed",
      ...(record.output !== undefined && { output: record.output }),
      ...(record.error !== undefined && { error: record.error }),
    };
  }
  if (message.type === "event" && message.event.type === "step_started") {
    const name = message.event.step;
    const had = entries[name];
    if (!had?.outcome) entries[name] = { ...had, startedAt: had?.startedAt ?? now };
  }
  return { runId, entries, state: message.state };
}

const PRIORITY: NodeRunStatus[] = ["failed", "waiting", "running", "passed", "skipped"];

/**
 * The status of each node that has one, by node id (`workflow:<step>`). While the run is going, a started step is
 * running and a finished one passed or failed. Once it ends, a step that never ran is skipped (an untaken branch
 * arm, the steps after an early stop) and a loop step that was cut off is skipped too, unless the loop reported it
 * failed. A failed run leaves its unreached steps unmarked: they were not skipped, the run just never got there.
 */
export function deriveNodeStatuses(
  tracker: RunTracker,
  nodeIds: readonly string[],
): Record<string, NodeRunInfo> {
  const state = tracker.state;
  if (!state) return {};
  const over =
    state.status === "completed" || state.status === "failed" || state.status === "rejected";
  // A loop that carried on past a failed item names the step in its output; the step itself never got a result.
  const itemFailures = new Map<string, string>();
  if (state.status === "completed") {
    for (const f of failedItems(state.finalOutput)) {
      if (f.step !== "" && !itemFailures.has(f.step)) itemFailures.set(f.step, f.message);
    }
  }
  const waitingOn =
    state.status === "awaiting_approval" && state.pendingApproval
      ? baseStepName(state.pendingApproval.step)
      : null;

  const groups = new Map<string, NodeRunInfo[]>();
  for (const [name, entry] of Object.entries(tracker.entries)) {
    const step = baseStepName(name);
    let info: NodeRunInfo;
    if (entry.outcome === "failed") {
      info = { status: "failed", message: entry.error ?? "The step failed." };
    } else if (entry.outcome === "completed") {
      info = { status: "passed", output: entry.output };
    } else if (over) {
      const message = itemFailures.get(step);
      info = message !== undefined ? { status: "failed", message } : { status: "skipped" };
    } else if (waitingOn === step) {
      info = { status: "waiting" };
    } else {
      info = { status: "running" };
    }
    if (entry.startedAt !== undefined && entry.endedAt !== undefined) {
      info.durationMs = Math.max(0, entry.endedAt - entry.startedAt);
    }
    groups.set(step, [...(groups.get(step) ?? []), info]);
  }

  const result: Record<string, NodeRunInfo> = {};
  for (const id of nodeIds) {
    if (!id.startsWith("workflow:")) continue;
    const step = id.slice("workflow:".length);
    const infos = groups.get(step);
    if (!infos) {
      // A pause can come before the step's start event is seen; the approval still names its step.
      if (waitingOn === step) result[id] = { status: "waiting" };
      else if (state.status === "completed") result[id] = { status: "skipped" };
      continue;
    }
    const best = PRIORITY.find((s) => infos.some((i) => i.status === s))!;
    const chosen = infos.filter((i) => i.status === best);
    const last = chosen[chosen.length - 1]!;
    const failures = infos.filter((i) => i.status === "failed").length;
    result[id] = {
      ...last,
      ...(infos.length > 1 && { runs: infos.length }),
      ...(infos.length > 1 && failures > 0 && { failures }),
    };
  }
  return result;
}

/** What a status is called on screen and to a screen reader: never colour alone. */
export const STATUS_LABEL: Record<NodeRunStatus, string> = {
  running: "Running",
  waiting: "Waiting for approval",
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
};

/**
 * What the pill on a card says (KAM-242): "Done", "Failed" or, for a step that ran for several items, "2 failed";
 * "Needs key" when the reason is a credential that is not set, since the fix is different from a bug.
 */
export function pillText(info: NodeRunInfo): string {
  if (info.status === "passed") return "Done";
  if (info.status === "failed") {
    if (missingSecretNames(info.message).length > 0) return "Needs key";
    return info.failures !== undefined ? `${info.failures} failed` : "Failed";
  }
  return STATUS_LABEL[info.status];
}

/** The first line of a failure's reason, short enough for a card's summary line; the whole text is its tooltip. */
export function reasonLine(message: string | undefined): string | undefined {
  const line = message
    ?.split("\n")
    .find((l) => l.trim() !== "")
    ?.trim();
  if (!line) return undefined;
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** A glyph for each status, drawn with the label (hidden from a screen reader: the label says it). */
export const STATUS_ICON: Record<NodeRunStatus, string> = {
  running: "↻",
  waiting: "⏸",
  passed: "✓",
  failed: "✕",
  skipped: "−",
};
