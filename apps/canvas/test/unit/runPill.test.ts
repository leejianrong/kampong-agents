import { describe, expect, it } from "vitest";
import { pillText, reasonLine } from "../../src/runStatus.js";

// KAM-242: the pill on a card says Done, Failed, N failed or Needs key; the reason is one line.
describe("run pill", () => {
  it("says Done for a step that passed", () => {
    expect(pillText({ status: "passed" })).toBe("Done");
    expect(pillText({ status: "running" })).toBe("Running");
  });

  it("says Failed, or how many of a loop's items failed", () => {
    expect(pillText({ status: "failed", message: "boom" })).toBe("Failed");
    expect(pillText({ status: "failed", message: "boom", runs: 3, failures: 2 })).toBe("2 failed");
  });

  it("says Needs key when the reason is a credential that is not set", () => {
    expect(pillText({ status: "failed", message: "ALPHA_VANTAGE_KEY is not set." })).toBe(
      "Needs key",
    );
    expect(
      pillText({
        status: "failed",
        message: "ALPHA_VANTAGE_KEY is not set.",
        runs: 3,
        failures: 3,
      }),
    ).toBe("Needs key");
  });

  it("keeps the first line of a reason, cut to fit a card", () => {
    expect(reasonLine(undefined)).toBeUndefined();
    expect(reasonLine("\n  first line\nsecond")).toBe("first line");
    expect(reasonLine("x".repeat(200))).toHaveLength(90);
  });
});
