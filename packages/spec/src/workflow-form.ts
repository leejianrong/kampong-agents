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

export interface WorkflowStepFormInput {
  step: string;
  action: string;
  inputs?: string;
}

export interface WorkflowStepFormResult {
  success: boolean;
  step?: WorkflowStep;
  errors?: string[];
}

export function buildWorkflowStepFromForm(input: WorkflowStepFormInput): WorkflowStepFormResult {
  const candidate = {
    step: input.step,
    action: input.action,
    ...(input.inputs && {
      inputs: input.inputs
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    }),
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
