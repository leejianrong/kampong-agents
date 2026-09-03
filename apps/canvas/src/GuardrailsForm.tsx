import { useState } from "react";
import { buildGuardrailsFromForm, type FallbackAction, type Guardrails } from "@kampong/spec";

// Fallback action is a fixed choice, not free text (packages/spec's
// guardrailsSchema constrains it to what packages/engine actually
// implements) -- a select with the supported value(s) means the form can
// never submit something the schema would reject anyway.
const FALLBACK_ACTIONS: FallbackAction[] = ["escalate_to_human"];

// The "Set Guardrails" affordance -- confidence-threshold + fallback-action
// (PLAN.md Affordances "Confidence-threshold guardrail control"), the same
// structured, zero-LLM-calls pattern as ToolForm.tsx and WorkflowStepForm.tsx.

export interface GuardrailsFormProps {
  onSubmit: (guardrails: Guardrails) => void;
  onCancel: () => void;
}

export function GuardrailsForm({ onSubmit, onCancel }: GuardrailsFormProps) {
  const [confidenceThreshold, setConfidenceThreshold] = useState("0.8");
  const [fallbackAction, setFallbackAction] = useState<FallbackAction>("escalate_to_human");
  const [errors, setErrors] = useState<string[]>([]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const result = buildGuardrailsFromForm({
      confidenceThreshold: confidenceThreshold ? Number(confidenceThreshold) : undefined,
      fallbackAction,
    });
    if (!result.success || !result.guardrails) {
      setErrors(result.errors ?? ["Invalid guardrails"]);
      return;
    }
    onSubmit(result.guardrails);
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Set Guardrails">
      <label>
        Confidence threshold
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={confidenceThreshold}
          onChange={(e) => setConfidenceThreshold(e.target.value)}
        />
      </label>
      <label>
        Fallback action
        <select
          value={fallbackAction}
          onChange={(e) => setFallbackAction(e.target.value as FallbackAction)}
        >
          {FALLBACK_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {action}
            </option>
          ))}
        </select>
      </label>
      {errors.length > 0 && (
        <ul role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <button type="submit">Save Guardrails</button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
