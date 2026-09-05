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

  it("sets confidence_gate: true when the caller asks for a confidence gate", () => {
    const result = buildWorkflowStepFromForm({
      step: "evaluate_policy",
      action: "check_knowledge",
      confidenceGate: true,
    });

    expect(result.success).toBe(true);
    expect(result.step).toEqual({
      step: "evaluate_policy",
      action: "check_knowledge",
      confidence_gate: true,
    });
  });

  it("omits confidence_gate entirely when the caller doesn't ask for one", () => {
    const result = buildWorkflowStepFromForm({ step: "parse_request", action: "extract_entities" });

    expect(result.success).toBe(true);
    expect(result.step).toEqual({ step: "parse_request", action: "extract_entities" });
  });

  it("builds a valid condition (type: 'condition') step from structured input", () => {
    const result = buildWorkflowStepFromForm({
      kind: "condition",
      step: "handle_approval",
      if: "evaluation.eligible == true",
      then: "execute_tool(issue_refund)",
      else: "request_human_approval",
    });

    expect(result.success).toBe(true);
    expect(result.step).toEqual({
      step: "handle_approval",
      type: "condition",
      if: "evaluation.eligible == true",
      then: "execute_tool(issue_refund)",
      else: "request_human_approval",
    });
  });

  it("rejects a condition step missing a required branch target", () => {
    const result = buildWorkflowStepFromForm({
      kind: "condition",
      step: "handle_approval",
      if: "evaluation.eligible == true",
      then: "execute_tool(issue_refund)",
      else: "",
    });
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

  it("rejects a fallback_action the engine doesn't implement", () => {
    const result = buildGuardrailsFromForm({
      // Cast: only "escalate_to_human" is a valid FallbackAction; this
      // exercises the schema rejecting a value the type system would
      // otherwise catch at compile time (e.g. a hand-edited YAML spec).
      fallbackAction: "retry_automatically" as never,
    });
    expect(result.success).toBe(false);
  });
});
