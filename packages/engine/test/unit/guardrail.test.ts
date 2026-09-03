import { describe, expect, it } from "vitest";
import { isBelowConfidenceThreshold } from "../../src/guardrail.js";

// SLICES.md V2 unit test plan: "Guardrail confidence-threshold comparison
// logic is correct at and around the boundary value."
describe("isBelowConfidenceThreshold", () => {
  it("is false when confidence is exactly at the threshold (>= passes)", () => {
    expect(isBelowConfidenceThreshold(0.85, 0.85)).toBe(false);
  });

  it("is true just below the threshold", () => {
    expect(isBelowConfidenceThreshold(0.8499, 0.85)).toBe(true);
  });

  it("is false just above the threshold", () => {
    expect(isBelowConfidenceThreshold(0.8501, 0.85)).toBe(false);
  });

  it("is false when confidence is the maximum (1) against any threshold", () => {
    expect(isBelowConfidenceThreshold(1, 0.99)).toBe(false);
  });

  it("is true when confidence is the minimum (0) against any positive threshold", () => {
    expect(isBelowConfidenceThreshold(0, 0.01)).toBe(true);
  });
});
