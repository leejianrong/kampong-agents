import { describe, expect, it } from "vitest";
import { buildWorkflowStepFromForm } from "../../src/workflow-form.js";

// KAN-1859: the "Add Workflow Step" form builds an if/else branch of tool steps, and an early stop.
describe("buildWorkflowStepFromForm: branch and stop", () => {
  it("builds a branch from `step: tool` lines, with an optional else", () => {
    const r = buildWorkflowStepFromForm({
      kind: "branch",
      step: "route",
      if: "triage.confidence > 0.8",
      then: "answer: reply",
      else: "escalate",
    });
    expect(r.errors).toBeUndefined();
    expect(r.step).toEqual({
      step: "route",
      branch: {
        if: "triage.confidence > 0.8",
        then: [{ step: "answer", type: "tool", tool: "reply" }],
        else: [{ step: "escalate", type: "tool", tool: "escalate" }],
      },
    });
    const noElse = buildWorkflowStepFromForm({
      kind: "branch",
      step: "route",
      if: "x",
      then: "t",
      else: "  ",
    });
    expect(noElse.step).toEqual({
      step: "route",
      branch: { if: "x", then: [{ step: "t", type: "tool", tool: "t" }] },
    });
  });

  it("reports an empty then as an error", () => {
    const r = buildWorkflowStepFromForm({ kind: "branch", step: "r", if: "x", then: " " });
    expect(r.success).toBe(false);
    expect(r.errors?.[0]).toMatch(/then step/);
  });

  it("builds a stop with an optional reason and status", () => {
    expect(buildWorkflowStepFromForm({ kind: "stop", step: "halt" }).step).toEqual({
      step: "halt",
      stop: {},
    });
    expect(
      buildWorkflowStepFromForm({
        kind: "stop",
        step: "halt",
        reason: "nothing to do",
        status: "completed",
      }).step,
    ).toEqual({ step: "halt", stop: { reason: "nothing to do", status: "completed" } });
  });
});
