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

// KAN-1858 (version 1.1): a foreach whose body is a list of tool steps, one per line of `body` as `step: tool`
// (or just `tool`, which names the step after the tool). Every other kind of nested step is written in the YAML.
export interface WorkflowForEachStepFormInput {
  kind: "foreach";
  step: string;
  items: string;
  as: string;
  concurrency?: number;
  onError?: "fail" | "continue" | "retry";
  /** The `n` of `on_error: { retry: { n } }`; used only when `onError` is "retry". */
  retryCount?: number;
  body: string;
}

// KAN-1859 (version 1.1): an if/else branch whose arms are lists of tool steps, one per line as `step: tool` (or
// just `tool`), and an early stop. Switch branches and every other kind of nested step are written in the YAML.
export interface WorkflowBranchStepFormInput {
  kind: "branch";
  step: string;
  if: string;
  then: string;
  /** Optional: blank means nothing happens when the condition is false. */
  else?: string;
  /**
   * A switch branch instead of if/else (KAM-154): when `switch` is set, `if`, `then` and `else` are ignored. `cases`
   * is one `value: step: tool` (or `value: tool`) per line, a value repeated for more steps in one case; `default` is
   * `step: tool` lines, blank for none.
   */
  switch?: string;
  cases?: string;
  default?: string;
}

export interface WorkflowStopStepFormInput {
  kind: "stop";
  step: string;
  reason?: string;
  status?: "completed" | "skipped";
}

export type WorkflowStepFormInput =
  | WorkflowBranchStepFormInput
  | WorkflowStopStepFormInput
  | WorkflowForEachStepFormInput
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

function parseBodyLines(text: string): { steps: unknown[]; errors: string[] } {
  const steps: unknown[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon).trim();
    const tool = colon === -1 ? line : line.slice(colon + 1).trim();
    steps.push({ step: name, type: "tool", tool });
  }
  return {
    steps,
    errors: steps.length === 0 ? ["Add at least one body step as a tool name (or step: tool)"] : [],
  };
}

function parseCaseLines(text: string): {
  cases: Record<string, unknown[]>;
  errors: string[];
} {
  const cases: Record<string, unknown[]> = {};
  const errors: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    const value = colon === -1 ? "" : line.slice(0, colon).trim();
    const rest = colon === -1 ? "" : line.slice(colon + 1).trim();
    if (value === "" || rest === "") {
      errors.push(`"${line}" is not "value: step: tool"`);
      continue;
    }
    const body = parseBodyLines(rest);
    (cases[value] ??= []).push(...body.steps);
  }
  if (errors.length === 0 && Object.keys(cases).length === 0) {
    errors.push("Add at least one case as value: step: tool");
  }
  return { cases, errors };
}

export interface WorkflowStepFormResult {
  success: boolean;
  step?: WorkflowStep;
  errors?: string[];
}

export function buildWorkflowStepFromForm(input: WorkflowStepFormInput): WorkflowStepFormResult {
  let candidate: unknown;
  if (input.kind === "branch" && input.switch !== undefined) {
    const { cases, errors } = parseCaseLines(input.cases ?? "");
    if (errors.length > 0) return { success: false, errors };
    const other = input.default?.trim() ? parseBodyLines(input.default) : undefined;
    candidate = {
      step: input.step,
      branch: { switch: input.switch, cases, ...(other && { default: other.steps }) },
    };
  } else if (input.kind === "branch") {
    const then = parseBodyLines(input.then);
    if (then.errors.length > 0) {
      return {
        success: false,
        errors: then.errors.map((e) => e.replace("body step", "then step")),
      };
    }
    const other = input.else?.trim() ? parseBodyLines(input.else) : undefined;
    candidate = {
      step: input.step,
      branch: {
        if: input.if,
        then: then.steps,
        ...(other && { else: other.steps }),
      },
    };
  } else if (input.kind === "stop") {
    candidate = {
      step: input.step,
      stop: {
        ...(input.reason && { reason: input.reason }),
        ...(input.status && { status: input.status }),
      },
    };
  } else if (input.kind === "foreach") {
    const { steps, errors } = parseBodyLines(input.body);
    if (errors.length > 0) return { success: false, errors };
    const onError =
      input.onError === "retry"
        ? { retry: { n: input.retryCount ?? 3 } }
        : input.onError === "continue" || input.onError === "fail"
          ? input.onError
          : undefined;
    candidate = {
      step: input.step,
      foreach: {
        items: input.items,
        as: input.as,
        ...(input.concurrency !== undefined && { concurrency: input.concurrency }),
        ...(onError !== undefined && { on_error: onError }),
        steps,
      },
    };
  } else if (input.kind === "transform") {
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
