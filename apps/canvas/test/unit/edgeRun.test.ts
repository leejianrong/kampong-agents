import { describe, expect, it } from "vitest";
import { edgeRun, edgeRunPill, edgeRunText } from "../../src/edgeRun.js";

// KAM-241: a line takes the state of the step it leads into, with a count, always in words too.
describe("edge run state", () => {
  it("is idle for a step that did not run or was skipped", () => {
    expect(edgeRun(undefined)).toBeUndefined();
    expect(edgeRun({ status: "skipped" })).toBeUndefined();
  });

  it("is passed with the number of times the step ran, 1 outside a loop", () => {
    expect(edgeRun({ status: "passed" })).toEqual({ state: "passed", count: 1 });
    expect(edgeRun({ status: "passed", runs: 3 })).toEqual({ state: "passed", count: 3 });
  });

  it("is failed when a step failed, running while it goes or waits", () => {
    expect(edgeRun({ status: "failed", runs: 3 })).toEqual({ state: "failed", count: 3 });
    expect(edgeRun({ status: "running" })?.state).toBe("running");
    expect(edgeRun({ status: "waiting" })?.state).toBe("running");
  });

  it("says it in words and in the pill, not by colour", () => {
    expect(edgeRunText({ state: "passed", count: 3 })).toBe("Passed, 3 items");
    expect(edgeRunText({ state: "failed", count: 1 })).toBe("Failed, 1 item");
    expect(edgeRunText({ state: "failed", count: 3 })).toBe("Failed for at least one of 3 items");
    expect(edgeRunText({ state: "running", count: 1 })).toBe("Running");
    expect(edgeRunPill({ state: "passed", count: 3 })).toBe("✓ 3");
    expect(edgeRunPill({ state: "failed", count: 1 })).toBe("✕ 1");
  });
});
