import { useState } from "react";
import { buildWorkflowStepFromForm, type WorkflowStep } from "@kampong/spec";

// The "Add Workflow Step" affordance -- same structured, zero-LLM-calls
// pattern as ToolForm.tsx (PLAN.md Affordances, Q12/R5).

export interface WorkflowStepFormProps {
  onSubmit: (step: WorkflowStep) => void;
  onCancel: () => void;
}

export function WorkflowStepForm({ onSubmit, onCancel }: WorkflowStepFormProps) {
  const [step, setStep] = useState("");
  const [action, setAction] = useState("");
  const [inputs, setInputs] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const result = buildWorkflowStepFromForm({ step, action, inputs });
    if (!result.success || !result.step) {
      setErrors(result.errors ?? ["Invalid workflow step"]);
      return;
    }
    onSubmit(result.step);
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Add Workflow Step" className="md3-card md3-form">
      <h2 className="md3-title-medium">Add Workflow Step</h2>
      <label className="md3-field">
        <span className="md3-field__label md3-label-large">Step ID</span>
        <input className="md3-text-field" value={step} onChange={(e) => setStep(e.target.value)} />
      </label>
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
