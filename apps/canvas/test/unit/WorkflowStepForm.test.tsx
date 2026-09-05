import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowStepForm } from "../../src/WorkflowStepForm.js";

// KAN-1175: the "Add Workflow Step" modal used to only ever build the
// plain-action workflowStepSchema variant, with no way to author a
// `type: "condition"` branch or set `confidence_gate`. This exercises both
// variants end to end through the actual form component (Step kind toggle,
// the fields each kind shows, and what gets handed to onSubmit).

describe("WorkflowStepForm", () => {
  afterEach(() => {
    cleanup();
  });

  it("defaults to the action-step kind and builds a plain action step", () => {
    const onSubmit = vi.fn();
    render(<WorkflowStepForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "parse_request" } });
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "extract_entities" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Step" }));

    expect(onSubmit).toHaveBeenCalledWith({ step: "parse_request", action: "extract_entities" });
  });

  it("sets confidence_gate: true when the checkbox is checked", () => {
    const onSubmit = vi.fn();
    render(<WorkflowStepForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "evaluate_policy" } });
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "check_knowledge" } });
    fireEvent.click(screen.getByLabelText("Requires confidence gate"));
    fireEvent.click(screen.getByRole("button", { name: "Save Step" }));

    expect(onSubmit).toHaveBeenCalledWith({
      step: "evaluate_policy",
      action: "check_knowledge",
      confidence_gate: true,
    });
  });

  it("switches to the conditional-branch kind and builds a type: 'condition' step", () => {
    const onSubmit = vi.fn();
    render(<WorkflowStepForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Conditional branch" }));

    // Action-only fields are gone once "Conditional branch" is selected.
    expect(screen.queryByLabelText("Action")).toBeNull();
    expect(screen.queryByLabelText("Requires confidence gate")).toBeNull();

    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "handle_approval" } });
    fireEvent.change(screen.getByLabelText("If (condition)"), {
      target: { value: "evaluation.eligible == true" },
    });
    fireEvent.change(screen.getByLabelText("Then (target step id)"), {
      target: { value: "execute_tool(issue_refund)" },
    });
    fireEvent.change(screen.getByLabelText("Else (target step id)"), {
      target: { value: "request_human_approval" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Step" }));

    expect(onSubmit).toHaveBeenCalledWith({
      step: "handle_approval",
      type: "condition",
      if: "evaluation.eligible == true",
      then: "execute_tool(issue_refund)",
      else: "request_human_approval",
    });
  });

  it("shows a validation error and does not submit when a conditional branch is missing a required field", () => {
    const onSubmit = vi.fn();
    render(<WorkflowStepForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Conditional branch" }));
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "handle_approval" } });
    fireEvent.change(screen.getByLabelText("If (condition)"), {
      target: { value: "evaluation.eligible == true" },
    });
    // "then"/"else" left blank.
    fireEvent.click(screen.getByRole("button", { name: "Save Step" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("calls onCancel when Cancel is clicked", () => {
    const onCancel = vi.fn();
    render(<WorkflowStepForm onSubmit={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
