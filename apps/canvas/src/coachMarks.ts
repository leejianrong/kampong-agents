import { useCallback, useEffect, useRef, useState } from "react";

// First-run coach marks (KAM-220): three one-line marks cover the first five minutes. Pick a template, press Run
// (a Replay needs no keys), click a step to see its data. Each mark goes away when you do what it says, the whole
// tour can be skipped for good, and "Show tour" in the menu plays it again. The state is one small record in this
// browser's localStorage and nothing leaves it: no telemetry.

export type CoachMark = "template" | "run" | "step";

export const COACH_ORDER: readonly CoachMark[] = ["template", "run", "step"];

export const COACH_KEY = "kampong:coach-marks";

/** Where the tour is: not started (a workflow that was already there when the canvas first opened), on a mark, or over. */
export type CoachState =
  { status: "none" } | { status: "active"; index: number } | { status: "done" } | { status: "off" };

export function readCoachState(storage: Pick<Storage, "getItem"> | undefined): CoachState {
  try {
    const raw = storage?.getItem(COACH_KEY);
    if (!raw) return { status: "none" };
    const parsed = JSON.parse(raw) as { status?: unknown; index?: unknown };
    if (parsed.status === "done" || parsed.status === "off") return { status: parsed.status };
    if (
      parsed.status === "active" &&
      typeof parsed.index === "number" &&
      parsed.index >= 0 &&
      parsed.index < COACH_ORDER.length
    ) {
      return { status: "active", index: parsed.index };
    }
  } catch {
    // Unreadable or blocked storage: the tour is simply not remembered.
  }
  return { status: "none" };
}

export interface CoachFacts {
  /** There is no workflow to draw yet: the new-workflow or no-steps screen is up. */
  blank: boolean;
  /** The server offers templates (the hosted one does not yet). */
  hasTemplates: boolean;
  /** How many runs this session has started. */
  runCount: number;
  /** The latest run is over (completed, failed or rejected). */
  runOver: boolean;
  /** The node selected on the canvas, if any. */
  selectedId: string | null;
}

/** The mark to show now, or null when the one the tour is on has nothing to point at yet. */
export function markToShow(state: CoachState, facts: CoachFacts): CoachMark | null {
  if (state.status !== "active") return null;
  const mark = COACH_ORDER[state.index]!;
  if (mark === "template") return facts.blank && facts.hasTemplates ? "template" : null;
  if (mark === "run") return facts.blank ? null : "run";
  return facts.runOver && !facts.blank ? "step" : null;
}

export interface Coach {
  mark: CoachMark | null;
  /** 1-based position of the mark, and how many there are. */
  position: { at: number; of: number } | null;
  /** The person did what the mark says, or pressed Got it: on to the next. */
  next: () => void;
  /** Turn the tour off for good. */
  skip: () => void;
  /** Play the tour again from the first mark. */
  restart: () => void;
}

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function save(state: CoachState) {
  try {
    window.localStorage.setItem(COACH_KEY, JSON.stringify(state));
  } catch {
    // Not remembered; the tour still works for this page.
  }
}

/**
 * Drives the tour from what the canvas reports. A tour begins on its own only for a workflow that is new (blank) the
 * first time the canvas opens in this browser; anything already there is left alone, and "Show tour" starts it.
 */
export function useCoachMarks(facts: CoachFacts & { loaded: boolean }): Coach {
  const [state, setState] = useState<CoachState>(() => readCoachState(storage()));
  const runsAtMark = useRef(facts.runCount);
  const decided = useRef(false);

  const update = useCallback((next: CoachState) => {
    setState(next);
    save(next);
  }, []);

  // The first load decides whether this is a new workspace: blank means the tour starts, anything else means it never does.
  useEffect(() => {
    if (decided.current || !facts.loaded) return;
    decided.current = true;
    if (state.status === "none")
      update(facts.blank ? { status: "active", index: 0 } : { status: "done" });
  }, [facts.loaded, facts.blank, state.status, update]);

  const index = state.status === "active" ? state.index : -1;
  const shown = markToShow(state, facts);
  // A node that was already selected when the step mark came up does not finish it: the person has to pick one.
  const selectedWhenShown = useRef<string | null>(null);
  useEffect(() => {
    if (shown === "step") selectedWhenShown.current = facts.selectedId;
    // Only the mark coming up takes the snapshot.
  }, [shown]);

  // A mark is finished by the thing it asks for.
  useEffect(() => {
    if (index < 0) return;
    const mark = COACH_ORDER[index]!;
    if (mark === "template" && !facts.blank) update(advance(index));
    else if (mark === "run" && facts.runCount > runsAtMark.current) update(advance(index));
    else if (
      mark === "step" &&
      shown === "step" &&
      facts.selectedId !== null &&
      facts.selectedId !== selectedWhenShown.current
    ) {
      update(advance(index));
    }
  }, [index, shown, facts.blank, facts.runCount, facts.selectedId, update]);

  // Runs started before a mark came up do not count towards it.
  useEffect(() => {
    runsAtMark.current = facts.runCount;
    // Only the mark changing resets the baseline, not the count growing.
  }, [index]);

  const mark = shown;
  return {
    mark,
    position: mark ? { at: COACH_ORDER.indexOf(mark) + 1, of: COACH_ORDER.length } : null,
    next: () => {
      if (state.status === "active") update(advance(state.index));
    },
    skip: () => update({ status: "off" }),
    restart: () => update({ status: "active", index: 0 }),
  };
}

function advance(index: number): CoachState {
  return index + 1 >= COACH_ORDER.length
    ? { status: "done" }
    : { status: "active", index: index + 1 };
}
