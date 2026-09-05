import {
  guardrailsSchema,
  workflowStepSchema,
  type FallbackAction,
  type Guardrails,
  type WorkflowStep,
} from "./schema.js";

// The workflow-step and guardrails equivalents of tool-form.ts's structured,
// zero-LLM-calls "Add Tool" pattern (PLAN.md Affordances, Q12/R5) -- so
// building a two-step agent with a guardrail entirely on the canvas doesn't
// require touching YAML by hand.

// The two workflowStepSchema union variants (schema.ts), each as its own
// form-input shape (KAN-1175): a plain action step -- optionally
// confidence-gated (KAN-1105) -- versus an if/then/else conditional branch.
// `kind` discriminates which one to build; it defaults to "action" when
// omitted so every pre-existing caller (WorkflowStepForm before this change,
// the unit test below) that never set it keeps building an action step
// exactly as before.

export interface WorkflowActionStepFormInput {
  kind?: "action";
  step: string;
  action: string;
  inputs?: string;
  // Sets `confidence_gate: true` on the built step (KAN-1105/ADR-0009) --
  // only meaningful alongside a spec-level `guardrails.confidence_threshold`,
  // which is configured separately via buildGuardrailsFromForm below.
  confidenceGate?: boolean;
}

export interface WorkflowConditionStepFormInput {
  kind: "condition";
  step: string;
  if: string;
  then: string;
  else: string;
}

export type WorkflowStepFormInput = WorkflowActionStepFormInput | WorkflowConditionStepFormInput;

export interface WorkflowStepFormResult {
  success: boolean;
  step?: WorkflowStep;
  errors?: string[];
}

export function buildWorkflowStepFromForm(input: WorkflowStepFormInput): WorkflowStepFormResult {
  const candidate =
    input.kind === "condition"
      ? {
          step: input.step,
          type: "condition" as const,
          if: input.if,
          then: input.then,
          else: input.else,
        }
      : {
          step: input.step,
          action: input.action,
          ...(input.inputs && {
            inputs: input.inputs
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          }),
          ...(input.confidenceGate && { confidence_gate: true }),
        };

  const result = workflowStepSchema.safeParse(candidate);
  if (!result.success) {
    return { success: false, errors: result.error.issues.map((issue) => issue.message) };
  }
  return { success: true, step: result.data };
}

export interface GuardrailsFormInput {
  confidenceThreshold?: number;
  fallbackAction?: FallbackAction;
}

export interface GuardrailsFormResult {
  success: boolean;
  guardrails?: Guardrails;
  errors?: string[];
}

export function buildGuardrailsFromForm(input: GuardrailsFormInput): GuardrailsFormResult {
  const candidate = {
    ...(input.confidenceThreshold !== undefined && {
      confidence_threshold: input.confidenceThreshold,
    }),
    ...(input.fallbackAction && { fallback_action: input.fallbackAction }),
  };

  const result = guardrailsSchema.safeParse(candidate);
  if (!result.success) {
    return { success: false, errors: result.error.issues.map((issue) => issue.message) };
  }
  return { success: true, guardrails: result.data };
}
