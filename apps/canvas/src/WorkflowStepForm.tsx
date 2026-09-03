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
    <form onSubmit={handleSubmit} aria-label="Add Workflow Step">
      <label>
        Step ID
        <input value={step} onChange={(e) => setStep(e.target.value)} />
      </label>
      <label>
        Action
        <input value={action} onChange={(e) => setAction(e.target.value)} />
      </label>
      <label>
        Inputs (comma-separated)
        <input value={inputs} onChange={(e) => setInputs(e.target.value)} />
      </label>
      {errors.length > 0 && (
        <ul role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <button type="submit">Save Step</button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
