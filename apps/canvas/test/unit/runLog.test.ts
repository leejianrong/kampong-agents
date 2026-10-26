import { describe, expect, it } from "vitest";
import type { RunState } from "../../src/api.js";
import { buildRunLog, rowForStep } from "../../src/runLog.js";
import type { RunTracker } from "../../src/runStatus.js";

// KAM-243: the bottom run log reads one run's tracker into rows: a row per step and per loop item, with status,
// duration, and the Input / Output / Error the selected row shows.

const state = (over: Partial<RunState>): RunState => ({ status: "completed", trace: [], ...over });

const tracker = (entries: RunTracker["entries"], runState: RunState): RunTracker => ({
  runId: "r1",
  entries,
  state: runState,
});

describe("buildRunLog", () => {
  it("makes a row per step and per loop item, with durations and the item that failed", () => {
    const rows = buildRunLog(
      tracker(
        {
          each: { startedAt: 0, endedAt: 500, outcome: "completed", output: { results: [] } },
          "each[0].fetch": { startedAt: 10, endedAt: 190, outcome: "completed", output: { p: 1 } },
          "each[1].fetch": { startedAt: 200, endedAt: 210 },
          done: { startedAt: 510, endedAt: 513, outcome: "completed", output: "ok" },
        },
        state({
          finalOutput: {
            each: {
              results: [],
              errors: [{ index: 1, step: "fetch", message: "rate limited", item: "MSFT" }],
            },
          },
        }),
      ),
      '{"items":["AAPL","MSFT"]}',
    );
    expect(rows.map((r) => [r.label, r.status, r.depth, r.durationMs])).toEqual([
      ["each", "passed", 0, 500],
      ["fetch · #1", "passed", 1, 180],
      ["fetch · MSFT", "failed", 1, 10],
      ["done", "passed", 0, 3],
    ]);
    const failed = rows[2]!;
    expect(failed.error).toBe("rate limited");
    // The data the step could read: the run's input, plus the item it was on. The loop's own result and the
    // other items' results are not in it: an item reads only its own.
    expect(failed.input).toEqual({
      input: { items: ["AAPL", "MSFT"] },
      item: "MSFT",
    });
  });

  it("lists a loop before its items even when the loop's own result came last", () => {
    const rows = buildRunLog(
      tracker(
        {
          "each[0].fetch": { outcome: "completed", output: 1 },
          "each[1].fetch": { outcome: "completed", output: 2 },
          each: { outcome: "completed", output: { results: [1, 2], errors: [] } },
        },
        state({}),
      ),
      "",
    );
    expect(rows.map((r) => r.id)).toEqual(["each", "each[0].fetch", "each[1].fetch"]);
    expect(rows[2]!.input).toEqual({ input: "" });
  });

  it("marks a step that never ran as skipped once the run is over, and a running one as running", () => {
    const over = buildRunLog(tracker({ a: {} }, state({})), "");
    expect(over[0]!.status).toBe("skipped");
    const live = buildRunLog(tracker({ a: { startedAt: 1 } }, state({ status: "running" })), "");
    expect(live[0]!.status).toBe("running");
  });

  it("keeps a plain-text input as text", () => {
    const rows = buildRunLog(
      tracker({ a: { outcome: "completed", output: 1 } }, state({})),
      "hello",
    );
    expect(rows[0]!.input).toEqual({ input: "hello" });
  });
});

describe("rowForStep", () => {
  it("prefers a failed row for a step", () => {
    const rows = buildRunLog(
      tracker(
        {
          "l[0].f": { outcome: "completed", output: 1 },
          "l[1].f": { outcome: "failed", error: "boom" },
        },
        state({ status: "failed" }),
      ),
      "",
    );
    expect(rowForStep(rows, "f")?.id).toBe("l[1].f");
    expect(rowForStep(rows, "none")).toBeUndefined();
  });
});
