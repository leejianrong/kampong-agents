import { describe, expect, it } from "vitest";
import type { RunState } from "@kampong/engine";
import { describeOutcome, oneLine } from "../../src/run-outcome.js";

// KAM-309: a run's outcome in one plain sentence.

const step = (name: string, status: "completed" | "failed", error?: string) => ({
  step: name,
  status,
  ...(error ? { error } : {}),
});
const state = (over: Partial<RunState>): RunState => ({ status: "completed", trace: [], ...over });

describe("oneLine", () => {
  it("keeps the first line, squeezes spaces, and cuts a long one", () => {
    expect(oneLine("first\nsecond\nthird")).toBe("first");
    expect(oneLine("  a   b \n")).toBe("a b");
    expect(oneLine("x".repeat(500)).length).toBe(160);
    expect(oneLine(undefined)).toBe("");
  });
});

describe("describeOutcome", () => {
  it("a clean run is completed with its step count", () => {
    expect(
      describeOutcome(state({ trace: [step("a", "completed"), step("b", "completed")] })),
    ).toMatchObject({
      kind: "ok",
      text: "completed, 2 steps",
    });
  });

  it("a failed run carries the first line of its error only", () => {
    const o = describeOutcome(state({ status: "failed", error: "Upstream down\nbody: {…}\nmore" }));
    expect(o).toMatchObject({ kind: "failed", text: "failed: Upstream down" });
  });

  it("some steps failed: finished, with the count and the first failure", () => {
    const o = describeOutcome(
      state({
        trace: [
          step("each[0].fetch", "completed"),
          step("each[1].fetch", "failed", "usage limit reached"),
          step("report", "completed"),
        ],
      }),
    );
    expect(o).toMatchObject({ kind: "partial", failedSteps: 1, steps: 3 });
    expect(o.text).toBe("finished, 1 of 3 steps failed. First: each[1].fetch: usage limit reached");
  });

  it("every loop item failed: says nothing worked, though the run ended 'completed'", () => {
    const o = describeOutcome(
      state({
        trace: [
          step("each[0].fetch", "failed", "key not set"),
          step("each[1].fetch", "failed", "key not set"),
          step("report", "completed"),
        ],
      }),
    );
    expect(o.kind).toBe("failed");
    expect(o.text).toBe(
      "finished, but nothing worked: every item failed (2 failures). First: each[0].fetch: key not set",
    );
  });

  it("waiting, rejected and ended-early are said in words", () => {
    expect(
      describeOutcome(
        state({
          status: "awaiting_approval",
          pendingApproval: { step: "review", kind: "approval", reason: "ok?" } as never,
        }),
      ).text,
    ).toBe('waiting for approval at "review"');
    expect(describeOutcome(state({ status: "rejected", error: "Too risky" })).text).toBe(
      "rejected: Too risky",
    );
    expect(
      describeOutcome(state({ skipped: { step: "dupe", reason: "seen before" }, trace: [] })).text,
    ).toBe("ended early at dupe: seen before");
  });
});
