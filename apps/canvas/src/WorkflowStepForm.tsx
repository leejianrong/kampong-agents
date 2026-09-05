import { useState } from "react";
import { buildWorkflowStepFromForm, type WorkflowStep } from "@kampong/spec";

// The "Add Workflow Step" affordance -- same structured, zero-LLM-calls
// pattern as ToolForm.tsx (PLAN.md Affordances, Q12/R5).
//
// KAN-1175: this used to only ever build the plain-action variant of
// workflowStepSchema's union, with no way to author a `type: "condition"`
// branch or a `confidence_gate: true` step -- the write side of a shape the
// canvas could already render (specToGraph/Canvas.tsx are schema-shape-
// agnostic). The "Step kind" segmented control below picks which union
// variant buildWorkflowStepFromForm builds; only "Add" exists for workflow
// steps today (no edit-in-place affordance anywhere on the canvas), so this
// stays create-only to match that scope.

type StepKind = "action" | "condition";

export interface WorkflowStepFormProps {
  onSubmit: (step: WorkflowStep) => void;
  onCancel: () => void;
}

export function WorkflowStepForm({ onSubmit, onCancel }: WorkflowStepFormProps) {
  const [kind, setKind] = useState<StepKind>("action");
  const [step, setStep] = useState("");
  const [action, setAction] = useState("");
  const [inputs, setInputs] = useState("");
  const [confidenceGate, setConfidenceGate] = useState(false);
  const [ifCondition, setIfCondition] = useState("");
  const [thenTarget, setThenTarget] = useState("");
  const [elseTarget, setElseTarget] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const result =
      kind === "condition"
        ? buildWorkflowStepFromForm({
            kind: "condition",
            step,
            if: ifCondition,
            then: thenTarget,
            else: elseTarget,
          })
        : buildWorkflowStepFromForm({ step, action, inputs, confidenceGate });
    if (!result.success || !result.step) {
      setErrors(result.errors ?? ["Invalid workflow step"]);
      return;
    }
    onSubmit(result.step);
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Add Workflow Step" className="md3-card md3-form">
      <h2 className="md3-title-medium">Add Workflow Step</h2>

      <div className="md3-field">
        <span className="md3-field__label md3-label-large">Step kind</span>
        <div className="md3-segmented-button" role="group" aria-label="Step kind">
          <button
            type="button"
            aria-pressed={kind === "action"}
            className={
              kind === "action"
                ? "md3-segmented-button__segment md3-segmented-button__segment--selected"
                : "md3-segmented-button__segment"
            }
            onClick={() => setKind("action")}
          >
            Action step
          </button>
          <button
            type="button"
            aria-pressed={kind === "condition"}
            className={
              kind === "condition"
                ? "md3-segmented-button__segment md3-segmented-button__segment--selected"
                : "md3-segmented-button__segment"
            }
            onClick={() => setKind("condition")}
          >
            Conditional branch
          </button>
        </div>
      </div>

      <label className="md3-field">
        <span className="md3-field__label md3-label-large">Step ID</span>
        <input className="md3-text-field" value={step} onChange={(e) => setStep(e.target.value)} />
      </label>

      {kind === "action" ? (
        <>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Action</span>
            <input
              className="md3-text-field"
              value={action}
              onChange={(e) => setAction(e.target.value)}
            />
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Inputs (comma-separated)</span>
            <input
              className="md3-text-field"
              value={inputs}
              onChange={(e) => setInputs(e.target.value)}
            />
          </label>
          <label className="md3-checkbox-field">
            <input
              type="checkbox"
              className="md3-checkbox"
              checked={confidenceGate}
              onChange={(e) => setConfidenceGate(e.target.checked)}
            />
            <span className="md3-label-large">Requires confidence gate</span>
          </label>
        </>
      ) : (
        <>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">If (condition)</span>
            <input
              className="md3-text-field"
              value={ifCondition}
              onChange={(e) => setIfCondition(e.target.value)}
            />
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Then (target step id)</span>
            <input
              className="md3-text-field"
              value={thenTarget}
              onChange={(e) => setThenTarget(e.target.value)}
            />
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Else (target step id)</span>
            <input
              className="md3-text-field"
              value={elseTarget}
              onChange={(e) => setElseTarget(e.target.value)}
            />
          </label>
        </>
      )}

      {errors.length > 0 && (
        <ul role="alert" className="md3-error-list">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div className="md3-form-actions">
        <button type="submit" className="md3-button md3-button-filled">
          Save Step
        </button>
        <button type="button" className="md3-button md3-button-text" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
