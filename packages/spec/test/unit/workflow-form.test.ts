import { describe, expect, it } from "vitest";
import { buildGuardrailsFromForm, buildWorkflowStepFromForm } from "../../src/workflow-form.js";

describe("buildWorkflowStepFromForm", () => {
  it("builds a valid workflow step from structured input, splitting comma-separated inputs", () => {
    const result = buildWorkflowStepFromForm({
      step: "parse_request",
      action: "extract_entities",
      inputs: "customer_email, order_id",
    });

    expect(result.success).toBe(true);
    expect(result.step).toEqual({
      step: "parse_request",
      action: "extract_entities",
      inputs: ["customer_email", "order_id"],
    });
  });

  it("rejects a step with an empty id", () => {
    const result = buildWorkflowStepFromForm({ step: "", action: "do_thing" });
    expect(result.success).toBe(false);
  });
});

describe("buildGuardrailsFromForm", () => {
  it("builds valid guardrails from structured input", () => {
    const result = buildGuardrailsFromForm({
      confidenceThreshold: 0.85,
      fallbackAction: "escalate_to_human",
    });

    expect(result.success).toBe(true);
    expect(result.guardrails).toEqual({
      confidence_threshold: 0.85,
      fallback_action: "escalate_to_human",
    });
  });

  it("rejects a confidence threshold outside 0-1", () => {
    const result = buildGuardrailsFromForm({ confidenceThreshold: 1.5 });
    expect(result.success).toBe(false);
  });
});
