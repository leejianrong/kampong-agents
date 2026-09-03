import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../../src/condition.js";

// SLICES.md V2 integration test plan restated at unit scope: the operator
// grammar itself is pure logic and belongs here; the integration test
// (test/integration/guardrail.test.ts) covers it wired into a real run.
describe("evaluateCondition", () => {
  const stepOutputs = { evaluate_policy: { eligible: true, score: 42, region: "APAC" } };

  it("evaluates == against a boolean field", () => {
    expect(evaluateCondition("evaluate_policy.eligible == true", stepOutputs)).toBe(true);
    expect(evaluateCondition("evaluate_policy.eligible == false", stepOutputs)).toBe(false);
  });

  it("evaluates != ", () => {
    expect(evaluateCondition("evaluate_policy.eligible != false", stepOutputs)).toBe(true);
  });

  it("evaluates numeric comparisons", () => {
    expect(evaluateCondition("evaluate_policy.score > 40", stepOutputs)).toBe(true);
    expect(evaluateCondition("evaluate_policy.score >= 42", stepOutputs)).toBe(true);
    expect(evaluateCondition("evaluate_policy.score < 42", stepOutputs)).toBe(false);
    expect(evaluateCondition("evaluate_policy.score <= 42", stepOutputs)).toBe(true);
  });

  it("evaluates a quoted string literal", () => {
    expect(evaluateCondition('evaluate_policy.region == "APAC"', stepOutputs)).toBe(true);
    expect(evaluateCondition('evaluate_policy.region == "EMEA"', stepOutputs)).toBe(false);
  });

  it("throws a specific error for an unrecognized expression shape", () => {
    expect(() => evaluateCondition("not a condition", stepOutputs)).toThrow(
      /Unrecognized condition/,
    );
  });

  it("throws a specific error when the referenced step hasn't run yet", () => {
    expect(() => evaluateCondition("some_future_step.field == true", stepOutputs)).toThrow(
      /has not produced output yet/,
    );
  });
});
