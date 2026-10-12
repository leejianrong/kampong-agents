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
  // KAN-1842: per-step overrides (version 1.1 specs). Blank means "use the agent's own".
  instructions?: string;
  model?: string;
  temperature?: number;
}

export interface WorkflowConditionStepFormInput {
  kind: "condition";
  step: string;
  if: string;
  then: string;
  else: string;
}

// KAN-1429 (ADR-0021): the two new first-class step kinds -- a tool step (call
// a named tool as a normal step) and an approval step (human-in-the-loop pause).
export interface WorkflowToolStepFormInput {
  kind: "tool";
  step: string;
  tool: string;
}

export interface WorkflowApprovalStepFormInput {
  kind: "approval";
  step: string;
  message?: string;
}

// KAN-1860 (version 1.1): the data steps. `set` is the text of a multi-line field, one `name: expression`
// per line (split on the first colon, so an expression may hold more); blank lines are skipped.
export interface WorkflowTransformStepFormInput {
  kind: "transform";
  step: string;
  set: string;
}

export interface WorkflowValidateStepFormInput {
  kind: "validate";
  step: string;
  assert: string;
  onFail?: "fail" | "skip";
  message?: string;
}

export interface WorkflowDedupeStepFormInput {
  kind: "dedupe";
  step: string;
  key: string;
  ttl: string;
}

export type WorkflowStepFormInput =
  | WorkflowActionStepFormInput
  | WorkflowConditionStepFormInput
  | WorkflowToolStepFormInput
  | WorkflowApprovalStepFormInput
  | WorkflowTransformStepFormInput
  | WorkflowValidateStepFormInput
  | WorkflowDedupeStepFormInput;

function parseSetLines(text: string): { set: Record<string, string>; errors: string[] } {
  const set: Record<string, string> = {};
  const errors: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    const name = colon === -1 ? "" : line.slice(0, colon).trim();
    const expression = colon === -1 ? "" : line.slice(colon + 1).trim();
    if (name === "" || expression === "") {
      errors.push(`"${line}" is not "name: expression"`);
    } else {
      set[name] = expression;
    }
  }
  if (errors.length === 0 && Object.keys(set).length === 0) {
    errors.push("Add at least one value as name: expression");
  }
  return { set, errors };
}

export interface WorkflowStepFormResult {
  success: boolean;
  step?: WorkflowStep;
  errors?: string[];
}

export function buildWorkflowStepFromForm(input: WorkflowStepFormInput): WorkflowStepFormResult {
  let candidate: unknown;
  if (input.kind === "transform") {
    const { set, errors } = parseSetLines(input.set);
    if (errors.length > 0) return { success: false, errors };
    candidate = { step: input.step, type: "transform" as const, set };
  } else if (input.kind === "validate") {
    candidate = {
      step: input.step,
      type: "validate" as const,
      assert: input.assert,
      ...(input.onFail && { on_fail: input.onFail }),
      ...(input.message && { message: input.message }),
    };
  } else if (input.kind === "dedupe") {
    candidate = {
      step: input.step,
      type: "dedupe" as const,
      once: { key: input.key, ttl: input.ttl },
    };
  } else if (input.kind === "condition") {
    candidate = {
      step: input.step,
      type: "condition" as const,
      if: input.if,
      then: input.then,
      else: input.else,
    };
  } else if (input.kind === "tool") {
    candidate = { step: input.step, type: "tool" as const, tool: input.tool };
  } else if (input.kind === "approval") {
    candidate = {
      step: input.step,
      type: "approval" as const,
      ...(input.message && { message: input.message }),
    };
  } else {
    candidate = {
      step: input.step,
      action: input.action,
      ...(input.inputs && {
        inputs: input.inputs
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      }),
      ...(input.confidenceGate && { confidence_gate: true }),
      ...(input.instructions && { instructions: input.instructions }),
      ...(input.model && { model: input.model }),
      ...(input.temperature !== undefined && { temperature: input.temperature }),
    };
  }

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
