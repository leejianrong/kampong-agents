import { z } from "zod";
import type { AgentSpec, WorkflowStep } from "@kampong/spec";
import { evaluateCondition } from "./condition.js";
import { isBelowConfidenceThreshold } from "./guardrail.js";
import { callHttpTool, type HttpToolCallOptions } from "./http-tool.js";
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
      kind: "tool" | "guardrail";
      reason: string;
      toolName?: string;
    }
  | { type: "completed"; output: Record<string, unknown> }
  | { type: "rejected"; step: string; reason: string }
  | { type: "failed"; step?: string; error: string };

export interface EngineDeps {
  model: ModelClient;
  fetchImpl?: HttpToolCallOptions["fetchImpl"];
}

const EXECUTE_TOOL_PATTERN = /^execute_tool\(([A-Za-z0-9_]+)\)$/;
const REQUEST_HUMAN_APPROVAL = "request_human_approval";

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

        if (tool.requires_approval) {
          const decision = yield {
            type: "awaiting_approval",
            step: step.step,
            kind: "tool",
            toolName: tool.name,
            reason: `Tool "${tool.name}" requires approval before it runs.`,
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

        try {
          const output = await callHttpTool(tool, buildToolParams(stepOutputs, input), {
            fetchImpl: deps.fetchImpl,
          });
          stepOutputs[step.step] = output;
          yield { type: "step_completed", step: step.step, output };
        } catch (err) {
          yield { type: "failed", step: step.step, error: (err as Error).message };
          return;
        }
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
  if (step.query) lines.push(`Query: ${step.query}`);
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
