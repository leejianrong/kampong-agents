import { describe, expect, it } from "vitest";
import { describeOutcome, parseRunListLimit } from "../../src/run/run-list.js";

describe("parseRunListLimit (KAM-324)", () => {
  it("defaults when missing or unreadable", () => {
    expect(parseRunListLimit(undefined)).toBe(20);
    expect(parseRunListLimit("abc")).toBe(20);
  });
  it("keeps a sensible number and clamps the rest", () => {
    expect(parseRunListLimit("5")).toBe(5);
    expect(parseRunListLimit("0")).toBe(1);
    expect(parseRunListLimit("-4")).toBe(1);
    expect(parseRunListLimit("5000")).toBe(100);
    expect(parseRunListLimit("7.9")).toBe(7);
  });
});

describe("describeOutcome (KAM-324)", () => {
  it("names the ordinary statuses in plain words", () => {
    expect(describeOutcome("running", null)).toBe("Running");
    expect(describeOutcome("awaiting_approval", null)).toBe("Waiting for approval");
    expect(describeOutcome("completed", null)).toBe("Finished");
    expect(describeOutcome("rejected", null)).toBe("Rejected");
  });
  it("uses the first line of a failure, shortened", () => {
    expect(describeOutcome("failed", "\n  The model refused.\nstack...")).toBe(
      "The model refused.",
    );
    expect(describeOutcome("failed", null)).toBe("Failed");
    expect(describeOutcome("failed", "x".repeat(300)).length).toBe(120);
  });
});
