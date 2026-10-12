import { describe, expect, it } from "vitest";
import { buildWorkflowStepFromForm } from "../../src/workflow-form.js";

// KAN-1860: the form builders for the version 1.1 data steps.
describe("buildWorkflowStepFromForm: data steps", () => {
  it("builds a transform from 'name: expression' lines, splitting on the first colon", () => {
    const result = buildWorkflowStepFromForm({
      kind: "transform",
      step: "shape",
      set: "change: (a.close - a.open) / a.open * 100\n\nlabel: $join(a.tags, ': ')\n",
    });
    expect(result.errors).toBeUndefined();
    expect(result.step).toEqual({
      step: "shape",
      type: "transform",
      set: { change: "(a.close - a.open) / a.open * 100", label: "$join(a.tags, ': ')" },
    });
  });

  it("reports a transform line with no name or no expression, and an empty set", () => {
    for (const set of ["no colon here", ": expr", "name:", ""]) {
      const result = buildWorkflowStepFromForm({ kind: "transform", step: "s", set });
      expect(result.success, set).toBe(false);
      expect(result.errors?.length, set).toBeGreaterThan(0);
    }
  });

  it("builds a validate step, leaving out blank optional fields", () => {
    expect(
      buildWorkflowStepFromForm({
        kind: "validate",
        step: "check",
        assert: "a.open > 0",
        onFail: "skip",
        message: "bad open",
      }).step,
    ).toEqual({
      step: "check",
      type: "validate",
      assert: "a.open > 0",
      on_fail: "skip",
      message: "bad open",
    });
    expect(
      buildWorkflowStepFromForm({ kind: "validate", step: "check", assert: "true", message: "" })
        .step,
    ).toEqual({ step: "check", type: "validate", assert: "true" });
  });

  it("builds a dedupe step with a key and ttl", () => {
    const result = buildWorkflowStepFromForm({
      kind: "dedupe",
      step: "seen",
      key: "trigger.id",
      ttl: "24h",
    });
    expect(result.step).toEqual({
      step: "seen",
      type: "dedupe",
      once: { key: "trigger.id", ttl: "24h" },
    });
    expect(
      buildWorkflowStepFromForm({ kind: "dedupe", step: "seen", key: "", ttl: "24h" }).success,
    ).toBe(false);
  });
});
