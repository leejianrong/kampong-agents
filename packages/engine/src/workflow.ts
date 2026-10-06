import { z } from "zod";
import type { AgentSpec, Tool, WorkflowStep } from "@kampong/spec";
import { evaluateCondition } from "./condition.js";
import { isBelowConfidenceThreshold } from "./guardrail.js";
import {
  callHttpTool,
  extractField,
  substitutePlaceholders,
  type HttpToolCallOptions,
} from "./http-tool.js";
import type { ModelClient } from "./model.js";

// The workflow step-sequencer (PLAN.md Shape S3, SLICES.md V2 KAN-1103/1104/
// 1105). Deliberately NOT built on Mastra's own `workflows` module: the
// AgentSpec's workflow is its own small DSL (sequential steps, one
// condition-step type with if/then/else strings) rather than Mastra's
// workflow primitives, and the HITL pause/resume shape this slice needs
// (KAN-1104) is simplest and most testable as our own control flow around a
// Mastra-backed model call, not Mastra's in-flux tool-approval/suspend
// machinery (which is designed for their durable snapshot/resume system,
// not a single local synchronous run). Mastra is still what actually runs
// the model call (model.ts) and could back real tool-calling later.
//
// Implemented as an async generator that `yield`s at every meaningful point
// and `return`s once the run reaches a terminal state; `yield` doubles as
// the front-end-agnostic pause point KAN-1104 asks for -- whoever drives
// the generator (run.ts's `AgentRun`) decides what "pending approval" means
// for its front end (a browser modal here; CLI stdin, out of scope until
// V3, would drive the exact same generator).

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export type RunEvent =
  | { type: "step_started"; step: string }
  | { type: "step_completed"; step: string; output: unknown; confidence?: number }
  | {
      type: "awaiting_approval";
      step: string;
      // "approval" is a first-class approval step (KAN-1429); "tool" and
      // "guardrail" are the pre-existing implicit pauses (a requires_approval
      // tool, and a confidence-guardrail / request_human_approval branch).
      kind: "tool" | "guardrail" | "approval";
      reason: string;
      toolName?: string;
    }
  | { type: "completed"; output: Record<string, unknown> }
  | { type: "rejected"; step: string; reason: string }
  | { type: "failed"; step?: string; error: string };

export interface EngineDeps {
  model: ModelClient;
  fetchImpl?: HttpToolCallOptions["fetchImpl"];
  /** Resolves connector `${ENV}` tokens (KAN-1430). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Tool call pacing and retry delays (KAN-1846); real timers by default, injectable for replay and tests. */
  pacer?: HttpToolCallOptions["pacer"];
  clock?: HttpToolCallOptions["clock"];
  /** Runs `action: component` tools (KAN-1884); without one, a component tool fails visibly. */
  components?: ComponentDispatcher;
}

export type ComponentTool = Extract<Tool, { action: "component" }>;

/**
 * The legacy Slack and Gmail tool kinds expressed as calls to the first-party components (KAN-1886).
 * Both kinds stay valid in a spec; this is how they run when a component dispatcher is available.
 * `use` for these is pinned to the version that ships with kampong, not to a lockfile entry.
 */
export function desugarLegacyTool(tool: Tool): ComponentTool | undefined {
  const shared = {
    name: tool.name,
    action: "component" as const,
    ...(tool.requires_approval !== undefined && { requires_approval: tool.requires_approval }),
    ...(tool.extract !== undefined && { extract: tool.extract }),
  };
  if (tool.action === "slack_post_message") {
    return {
      ...shared,
      use: "kampong/slack@1.0.0",
      op: "post_message",
      with: { channel: tool.channel, text: tool.text },
      secrets: { token: tool.token },
    };
  }
  if (tool.action === "gmail_send") {
    return {
      ...shared,
      use: "kampong/gmail@1.0.0",
      op: "send",
      with: { to: tool.to, subject: tool.subject, body: tool.body },
      secrets: { token: tool.token },
    };
  }
  return undefined;
}

/** What a component call needs from the engine at run time. */
export type ComponentRuntime = Pick<EngineDeps, "env" | "fetchImpl" | "pacer" | "clock">;

export interface PreparedComponentCall {
  /** The op's effect decides this unless the spec set `requires_approval`. */
  requiresApproval: boolean;
  run(input: Record<string, unknown>, runtime: ComponentRuntime): Promise<unknown>;
}

/**
 * The seam between the workflow and the component machinery (component.ts, component-registry.ts), so
 * the workflow, which is vendored into exports, does not depend on them. `prepare` resolves the
 * component (and fails if it cannot) before any approval is asked for.
 */
export interface ComponentDispatcher {
  prepare(tool: ComponentTool): Promise<PreparedComponentCall>;
}

const EXECUTE_TOOL_PATTERN = /^execute_tool\(([A-Za-z0-9_]+)\)$/;
const REQUEST_HUMAN_APPROVAL = "request_human_approval";

// KAN-1429 (ADR-0021): `{{ step.field }}` / `{{ input }}` data references
// resolve in an action step's query, a tool step's fields, and an approval
// step's message, via the shared substitutePlaceholders resolver (KAN-1430
// unified it to handle both `{{ ... }}` and the original `{...}` form). The
// lookup keys are buildToolParams' flat map (`input` plus namespaced
// `step.field` scalars); an unknown key is left as-is rather than guessed.

const structuredStepSchema = z.object({
  result: z.record(z.string(), z.unknown()),
  confidence: z.number().min(0).max(1),
});

export async function* runWorkflow(
  spec: AgentSpec,
  deps: EngineDeps,
  input: string,
): AsyncGenerator<RunEvent, void, ApprovalDecision | undefined> {
  const stepOutputs: Record<string, unknown> = {};
  const guardrails = spec.agent.guardrails;

  for (const step of spec.agent.workflow) {
    yield { type: "step_started", step: step.step };

    if (isConditionStep(step)) {
      let branch: string;
      try {
        branch = evaluateCondition(step.if, stepOutputs) ? step.then : step.else;
      } catch (err) {
        yield { type: "failed", step: step.step, error: (err as Error).message };
        return;
      }

      if (branch === REQUEST_HUMAN_APPROVAL) {
        const decision = yield {
          type: "awaiting_approval",
          step: step.step,
          kind: "guardrail",
          reason: `Step "${step.step}" requested human approval.`,
        };
        if (!decision?.approved) {
          yield {
            type: "rejected",
            step: step.step,
            reason: decision?.reason ?? "Approval was rejected.",
          };
          return;
        }
        stepOutputs[step.step] = { approved: true };
        yield { type: "step_completed", step: step.step, output: stepOutputs[step.step] };
        continue;
      }

      const toolMatch = EXECUTE_TOOL_PATTERN.exec(branch);
      if (toolMatch) {
        const toolName = toolMatch[1]!;
        const tool = spec.agent.tools?.find((t) => t.name === toolName);
        if (!tool) {
          yield {
            type: "failed",
            step: step.step,
            error: `Condition references unknown tool "${toolName}".`,
          };
          return;
        }

        const result = yield* executeTool(tool, step.step, stepOutputs, input, deps);
        if (!result) return;
        stepOutputs[step.step] = result.output;
        yield { type: "step_completed", step: step.step, output: result.output };
        continue;
      }

      // V2 only implements the two branch shapes above (execute_tool(...)
      // and request_human_approval); an unrecognized value must fail
      // loudly here rather than silently "succeed" as an opaque annotation
      // -- fail-visibly is a load-bearing project convention (AGENTS.md,
      // ADR-0004), not just a model-call rule.
      yield {
        type: "failed",
        step: step.step,
        error: `Condition step "${step.step}" resolved to an unsupported branch action "${branch}" (expected "execute_tool(<tool_name>)" or "request_human_approval").`,
      };
      return;
    }

    // KAN-1429 (ADR-0021): a tool step -- call a named tool as a normal,
    // always-run step (not gated behind a condition branch). Same
    // approval/param-resolution behavior as the execute_tool(...) branch above.
    if (isToolStep(step)) {
      const tool = spec.agent.tools?.find((t) => t.name === step.tool);
      if (!tool) {
        yield {
          type: "failed",
          step: step.step,
          error: `Tool step "${step.step}" references unknown tool "${step.tool}".`,
        };
        return;
      }
      const result = yield* executeTool(tool, step.step, stepOutputs, input, deps);
      if (!result) return;
      stepOutputs[step.step] = result.output;
      yield { type: "step_completed", step: step.step, output: result.output };
      continue;
    }

    // KAN-1429 (ADR-0021): a first-class approval step -- pause for a human,
    // reject stops the run (reusing the approval/resume machinery).
    if (isApprovalStep(step)) {
      const reason = step.message
        ? substitutePlaceholders(step.message, buildToolParams(stepOutputs, input))
        : `Step "${step.step}" requires human approval.`;
      const decision = yield {
        type: "awaiting_approval",
        step: step.step,
        kind: "approval",
        reason,
      };
      if (!decision?.approved) {
        yield {
          type: "rejected",
          step: step.step,
          reason: decision?.reason ?? "Approval was rejected.",
        };
        return;
      }
      stepOutputs[step.step] = {
        approved: true,
        ...(decision.reason ? { reason: decision.reason } : {}),
      };
      yield { type: "step_completed", step: step.step, output: stepOutputs[step.step] };
      continue;
    }

    let stepResult: { output: unknown; confidence?: number };
    try {
      stepResult = await runActionStep(step, spec, deps, stepOutputs, input);
    } catch (err) {
      yield { type: "failed", step: step.step, error: (err as Error).message };
      return;
    }
    stepOutputs[step.step] = stepResult.output;
    yield {
      type: "step_completed",
      step: step.step,
      output: stepResult.output,
      confidence: stepResult.confidence,
    };

    if (step.confidence_gate && guardrails?.confidence_threshold !== undefined) {
      const confidence = stepResult.confidence ?? 1;
      if (isBelowConfidenceThreshold(confidence, guardrails.confidence_threshold)) {
        if (guardrails.fallback_action !== "escalate_to_human") {
          yield {
            type: "failed",
            step: step.step,
            error: `Guardrail breach at step "${step.step}" (confidence ${confidence} < threshold ${guardrails.confidence_threshold}) but fallback_action "${guardrails.fallback_action ?? "(none)"}" isn't supported.`,
          };
          return;
        }
        const decision = yield {
          type: "awaiting_approval",
          step: step.step,
          kind: "guardrail",
          reason: `Confidence ${confidence} at step "${step.step}" is below the guardrail threshold ${guardrails.confidence_threshold}.`,
        };
        if (!decision?.approved) {
          yield {
            type: "rejected",
            step: step.step,
            reason: decision?.reason ?? "Approval was rejected.",
          };
          return;
        }
      }
    }
  }

  yield { type: "completed", output: stepOutputs };
}

function isConditionStep(step: WorkflowStep): step is Extract<WorkflowStep, { type: "condition" }> {
  return "type" in step && step.type === "condition";
}

function isToolStep(step: WorkflowStep): step is Extract<WorkflowStep, { type: "tool" }> {
  return "type" in step && step.type === "tool";
}

function isApprovalStep(step: WorkflowStep): step is Extract<WorkflowStep, { type: "approval" }> {
  return "type" in step && step.type === "approval";
}

async function runActionStep(
  step: Extract<WorkflowStep, { action: string }>,
  spec: AgentSpec,
  deps: EngineDeps,
  stepOutputs: Record<string, unknown>,
  input: string,
): Promise<{ output: unknown; confidence?: number }> {
  const instructions = `Role: ${spec.agent.role}\nGoal: ${spec.agent.goal}`;
  const prompt = buildStepPrompt(step, input, stepOutputs);

  if (step.confidence_gate) {
    const structured = await deps.model.generateStructured({
      instructions,
      prompt,
      schema: structuredStepSchema,
    });
    return { output: structured.result, confidence: structured.confidence };
  }

  const text = await deps.model.generateText({ instructions, prompt });
  return { output: { text } };
}

function buildStepPrompt(
  step: Extract<WorkflowStep, { action: string }>,
  input: string,
  stepOutputs: Record<string, unknown>,
): string {
  const lines = [`User input: ${input}`, `Step: ${step.step}`, `Action: ${step.action}`];
  if (step.inputs?.length) lines.push(`Relevant fields: ${step.inputs.join(", ")}`);
  if (step.query)
    lines.push(`Query: ${substitutePlaceholders(step.query, buildToolParams(stepOutputs, input))}`);
  if (Object.keys(stepOutputs).length > 0) {
    lines.push(`Prior step outputs: ${JSON.stringify(stepOutputs)}`);
  }
  if (step.confidence_gate) {
    lines.push(
      "Respond with a JSON object matching { result: <object with fields relevant to this step>, confidence: <number 0-1, how confident you are in this result> }.",
    );
  }
  return lines.join("\n");
}

// Runs one tool for a step: approval first (an explicit `requires_approval`, else the op's effect for
// a component), then the call. Yields the awaiting_approval / rejected / failed events itself and
// returns the output, or undefined once the run has reached a terminal state.
async function* executeTool(
  declared: Tool,
  stepName: string,
  stepOutputs: Record<string, unknown>,
  input: string,
  deps: EngineDeps,
): AsyncGenerator<RunEvent, { output: unknown } | undefined, ApprovalDecision | undefined> {
  const params = buildToolParams(stepOutputs, input);
  // With a component dispatcher configured, the legacy Slack and Gmail kinds run as their first-party
  // components. Without one (a bare engine, an export that has not vendored components) they take the
  // original request builders.
  const tool = (deps.components ? desugarLegacyTool(declared) : undefined) ?? declared;
  let needsApproval = tool.requires_approval ?? false;
  let prepared: PreparedComponentCall | undefined;

  if (tool.action === "component") {
    // Resolved before asking for approval: the op's effect decides the default, and a component that
    // cannot be found should fail the run, not ask a human to approve a call that cannot happen.
    try {
      if (!deps.components) {
        throw new Error(
          `Tool "${tool.name}" uses component ${tool.use}, but no component registry is configured.`,
        );
      }
      prepared = await deps.components.prepare(tool);
    } catch (err) {
      yield { type: "failed", step: stepName, error: (err as Error).message };
      return undefined;
    }
    needsApproval = prepared.requiresApproval;
  }

  if (needsApproval) {
    const decision = yield {
      type: "awaiting_approval",
      step: stepName,
      kind: "tool",
      toolName: tool.name,
      reason: `Tool "${tool.name}" requires approval before it runs.`,
    };
    if (!decision?.approved) {
      yield {
        type: "rejected",
        step: stepName,
        reason: decision?.reason ?? "Approval was rejected.",
      };
      return undefined;
    }
  }

  try {
    if (tool.action === "component" && prepared) {
      // `with` takes run data (`{{ step.field }}`) but `config` and `secrets` never do: config can form
      // part of a host, and a secret slot only ever names an environment variable.
      const result = await prepared.run(substituteDeep(tool.with, params), {
        env: deps.env,
        fetchImpl: deps.fetchImpl,
        pacer: deps.pacer,
        clock: deps.clock,
      });
      return { output: extractField(result, tool.extract) };
    }
    // callHttpTool builds the request (generic HTTP or a connector) and resolves
    // `{{ step.field }}` / `{placeholder}` references in every field via substitutePlaceholders
    // (KAN-1429/KAN-1430).
    const output = await callHttpTool(tool, params, {
      fetchImpl: deps.fetchImpl,
      env: deps.env,
      pacer: deps.pacer,
      clock: deps.clock,
    });
    return { output };
  } catch (err) {
    yield { type: "failed", step: stepName, error: (err as Error).message };
    return undefined;
  }
}

/** Resolves `{{ ... }}` references in every string of a `with` block, leaving other values typed. */
function substituteDeep(value: unknown, params: Record<string, string>): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return substitutePlaceholders(node, params);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return (walk(value ?? {}) as Record<string, unknown>) ?? {};
}

/**
 * Tool params for `execute_tool(name)` resolve from every prior step's
 * scalar output fields, namespaced under that step's name (`{step_name.field}`
 * placeholders in the tool URL), plus the run's original input under its own
 * top-level `input` key -- V2's schema has no explicit param-mapping syntax
 * (e.g. `{{steps.x.field}}`), so this is a deliberately simple stand-in.
 * Namespacing (rather than a flat merge of every step's fields into one bag)
 * is what stops two steps that happen to share a field name -- or a field
 * literally named `input` -- from silently clobbering each other before
 * substitution. A placeholder with no matching key is left as-is in the URL
 * (see substitutePlaceholders), which surfaces as an honest HTTP failure
 * rather than a silent wrong value.
 */
function buildToolParams(
  stepOutputs: Record<string, unknown>,
  input: string,
): Record<string, string> {
  const params: Record<string, string> = { input };
  for (const [stepName, output] of Object.entries(stepOutputs)) {
    if (output && typeof output === "object") {
      for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          params[`${stepName}.${key}`] = String(value);
        }
      }
    } else if (
      typeof output === "string" ||
      typeof output === "number" ||
      typeof output === "boolean"
    ) {
      params[stepName] = String(output);
    }
  }
  return params;
}
