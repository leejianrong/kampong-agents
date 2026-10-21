import { describe, expect, it } from "vitest";
import type { RunState } from "../../src/api.js";
import { formatDuration, summarizeRun } from "../../src/runSummary.js";

// KAM-219: one run in a word, an icon and a colour role. A run that carried failed items on is a warning.

const foreachErrors = {
  each: { results: [], errors: [{ index: 0, step: "fetch", message: "429", item: "MSFT" }] },
};

describe("summarizeRun", () => {
  it("calls a clean run completed", () => {
    const s = summarizeRun({ status: "completed", trace: [], finalOutput: {} } as RunState);
    expect(s).toMatchObject({ kind: "completed", label: "completed", errors: 0 });
  });

  it("calls a run that carried failed items on completed with errors, never completed", () => {
    const s = summarizeRun({
      status: "completed",
      trace: [],
      finalOutput: foreachErrors,
    } as unknown as RunState);
    expect(s).toMatchObject({
      kind: "completed_with_errors",
      label: "completed with 1 error",
      errors: 1,
    });
  });

  it("says the other states in words", () => {
    const kind = (status: string) => summarizeRun({ status, trace: [] } as unknown as RunState);
    expect(kind("awaiting_approval").label).toBe("waiting for approval");
    expect(kind("failed")).toMatchObject({ kind: "failed", label: "failed" });
    expect(kind("running").kind).toBe("running");
  });
});

describe("formatDuration", () => {
  it("reads a length as people say it", () => {
    expect(formatDuration(400)).toBe("0.4 s");
    expect(formatDuration(12_000)).toBe("12 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
  });
});
