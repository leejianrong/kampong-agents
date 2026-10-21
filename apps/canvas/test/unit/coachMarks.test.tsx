import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoachMarks } from "../../src/CoachMarks.js";
import {
  COACH_KEY,
  markToShow,
  readCoachState,
  useCoachMarks,
  type CoachFacts,
} from "../../src/coachMarks.js";

// KAM-220: the first-run marks. They start on a new blank workflow only, follow what the person does, can be
// skipped for good, and "Show tour" plays them again. The state is one localStorage record; nothing leaves the browser.

const FACTS: CoachFacts & { loaded: boolean } = {
  loaded: true,
  blank: true,
  hasTemplates: true,
  runCount: 0,
  runOver: false,
  selectedId: null,
};

const stored = () => JSON.parse(localStorage.getItem(COACH_KEY) ?? "null");

describe("markToShow", () => {
  it("points at each thing only when it is there to point at", () => {
    const at = (index: number) => ({ status: "active" as const, index });
    expect(markToShow(at(0), FACTS)).toBe("template");
    expect(markToShow(at(0), { ...FACTS, hasTemplates: false })).toBeNull();
    expect(markToShow(at(1), FACTS)).toBeNull();
    expect(markToShow(at(1), { ...FACTS, blank: false })).toBe("run");
    expect(markToShow(at(2), { ...FACTS, blank: false })).toBeNull();
    expect(markToShow(at(2), { ...FACTS, blank: false, runOver: true })).toBe("step");
    expect(markToShow({ status: "off" }, FACTS)).toBeNull();
    expect(markToShow({ status: "done" }, FACTS)).toBeNull();
  });
});

describe("readCoachState", () => {
  it("reads what was stored and shrugs off what it cannot read", () => {
    const from = (value: string | null) => readCoachState({ getItem: () => value });
    expect(from(null)).toEqual({ status: "none" });
    expect(from("not json")).toEqual({ status: "none" });
    expect(from('{"status":"off"}')).toEqual({ status: "off" });
    expect(from('{"status":"active","index":1}')).toEqual({ status: "active", index: 1 });
    expect(from('{"status":"active","index":9}')).toEqual({ status: "none" });
    expect(readCoachState(undefined)).toEqual({ status: "none" });
  });
});

describe("useCoachMarks", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("walks a new workspace through the three marks as the person does each thing", () => {
    const { result, rerender } = renderHook((facts: typeof FACTS) => useCoachMarks(facts), {
      initialProps: FACTS,
    });
    expect(result.current.mark).toBe("template");
    expect(result.current.position).toEqual({ at: 1, of: 3 });

    rerender({ ...FACTS, blank: false });
    expect(result.current.mark).toBe("run");

    // A run already in the session before the mark came up does not count; one started after it does.
    rerender({ ...FACTS, blank: false, runCount: 1, selectedId: "workflow:a" });
    expect(result.current.mark).toBeNull();
    rerender({ ...FACTS, blank: false, runCount: 1, runOver: true, selectedId: "workflow:a" });
    expect(result.current.mark).toBe("step");

    // A node already selected when the mark came up does not finish it; picking another does.
    rerender({ ...FACTS, blank: false, runCount: 1, runOver: true, selectedId: "workflow:b" });
    expect(result.current.mark).toBeNull();
    expect(stored()).toEqual({ status: "done" });
  });

  it("never starts for a workflow that was already there, but Show tour plays it", () => {
    const existing = { ...FACTS, blank: false };
    const { result } = renderHook(() => useCoachMarks(existing));
    expect(result.current.mark).toBeNull();
    expect(stored()).toEqual({ status: "done" });
    // Playing it again skips what is already done (a workflow exists) and starts at Run.
    act(() => result.current.restart());
    expect(result.current.mark).toBe("run");
    expect(stored()).toEqual({ status: "active", index: 1 });
  });

  it("Skip turns it off for good, across a reload", () => {
    const first = renderHook(() => useCoachMarks(FACTS));
    act(() => first.result.current.skip());
    expect(first.result.current.mark).toBeNull();
    first.unmount();
    const second = renderHook(() => useCoachMarks(FACTS));
    expect(second.result.current.mark).toBeNull();
    expect(stored()).toEqual({ status: "off" });
  });

  it("does not start twice: a finished tour stays finished on a blank workflow", () => {
    localStorage.setItem(COACH_KEY, JSON.stringify({ status: "done" }));
    const { result } = renderHook(() => useCoachMarks(FACTS));
    expect(result.current.mark).toBeNull();
  });

  it("works with storage blocked", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      const { result } = renderHook(() => useCoachMarks(FACTS));
      expect(result.current.mark).toBe("template");
      act(() => result.current.skip());
      expect(result.current.mark).toBeNull();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

describe("CoachMarks card", () => {
  afterEach(cleanup);

  const coach = (mark: "template" | "run" | "step", over = {}) => ({
    mark,
    position: { at: ["template", "run", "step"].indexOf(mark) + 1, of: 3 },
    next: () => {},
    skip: () => {},
    restart: () => {},
    ...over,
  });

  it("says the run mark in words that match what the server can do", () => {
    const { rerender } = render(<CoachMarks coach={coach("run")} replay />);
    expect(screen.getByRole("region", { name: "Tour, step 2 of 3" }).textContent).toContain(
      "no keys are needed",
    );
    rerender(<CoachMarks coach={coach("run")} replay={false} />);
    expect(screen.getByTestId("coach-mark").textContent).not.toContain("keys");
  });

  it("is a labelled region with Skip tour, Got it on the last mark, and Escape inside it skips", () => {
    let skipped = 0;
    let advanced = 0;
    render(
      <CoachMarks
        coach={coach("step", { skip: () => skipped++, next: () => advanced++ })}
        replay
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(advanced).toBe(1);
    fireEvent.keyDown(screen.getByRole("button", { name: "Skip tour" }), { key: "Escape" });
    expect(skipped).toBe(1);
  });

  it("draws nothing when no mark is due", () => {
    render(<CoachMarks coach={{ ...coach("run"), mark: null, position: null }} replay />);
    expect(screen.queryByTestId("coach-mark")).toBeNull();
  });
});
