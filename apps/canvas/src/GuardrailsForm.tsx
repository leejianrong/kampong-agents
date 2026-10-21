import { PanelError, PanelFooter } from "./Panel";
import { useId, useRef, useState } from "react";
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
  /** The spec's current guardrails, when the form edits them (the inspector, KAM-211). */
  initial?: Guardrails | undefined;
  onSubmit: (guardrails: Guardrails) => void;
  onCancel: () => void;
}

export function GuardrailsForm({ initial, onSubmit, onCancel }: GuardrailsFormProps) {
  const [confidenceThreshold, setConfidenceThreshold] = useState(
    String(initial?.confidence_threshold ?? "0.8"),
  );
  const [fallbackAction, setFallbackAction] = useState<FallbackAction>(
    initial?.fallback_action ?? "escalate_to_human",
  );
  const [errors, setErrors] = useState<string[]>([]);
  const id = useId();
  const thresholdInput = useRef<HTMLInputElement>(null);

  // KAM-180: the check is shown under the field as you type, in the page's own style, not as a browser bubble. A
  // blank threshold is allowed (there is none); anything else must be a number from 0 to 1.
  const thresholdProblem = thresholdProblemOf(confidenceThreshold);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (thresholdProblem) {
      thresholdInput.current?.focus();
      return;
    }
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
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Set Guardrails"
      className="md3-form md3-form--fill"
    >
      <div className="md3-field">
        <label className="md3-field__label md3-label-large" htmlFor={`${id}-threshold`}>
          Confidence threshold
        </label>
        <input
          ref={thresholdInput}
          id={`${id}-threshold`}
          className="md3-text-field"
          type="number"
          inputMode="decimal"
          step="any"
          value={confidenceThreshold}
          aria-invalid={thresholdProblem !== null || undefined}
          aria-describedby={`${id}-threshold-help${thresholdProblem ? ` ${id}-threshold-error` : ""}`}
          onChange={(e) => setConfidenceThreshold(e.target.value)}
        />
        <span id={`${id}-threshold-help`} className="md3-body-small md3-field__hint">
          A step marked as needing a confidence check pauses for a person when the model is less
          sure than this. A number from 0 to 1: 0.8 pauses below 80% sure, 1 pauses on anything
          short of certain, and blank sets no threshold.
        </span>
        {thresholdProblem && (
          <span
            id={`${id}-threshold-error`}
            role="alert"
            className="md3-body-small md3-field__error"
            data-testid="threshold-error"
          >
            Problem: {thresholdProblem}
          </span>
        )}
      </div>
      <div className="md3-field">
        <label className="md3-field__label md3-label-large" htmlFor={`${id}-fallback`}>
          Fallback action
        </label>
        <select
          id={`${id}-fallback`}
          className="md3-text-field"
          aria-describedby={`${id}-fallback-help`}
          value={fallbackAction}
          onChange={(e) => setFallbackAction(e.target.value as FallbackAction)}
        >
          {FALLBACK_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {action}
            </option>
          ))}
        </select>
        <span id={`${id}-fallback-help`} className="md3-body-small md3-field__hint">
          What happens when a step falls below the threshold: the run stops and waits for a person
          to approve or reject it. This is the only action for now.
        </span>
      </div>
      <PanelError messages={errors} />
      <PanelFooter save="Save guardrails" onCancel={onCancel} />
    </form>
  );
}

/** Why a threshold text is not usable, in words, or null when it is blank or a number from 0 to 1. */
export function thresholdProblemOf(text: string): string | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return "the threshold must be a number from 0 to 1.";
  if (value < 0 || value > 1) {
    return `the threshold must be from 0 to 1, and ${text.trim()} is ${value < 0 ? "below" : "above"} that.`;
  }
  return null;
}
