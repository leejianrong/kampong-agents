// Vendored from packages/engine/src/run.ts as part of a `kampong export` --
// see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. The
// only change from the source file is the `AgentSpec` type import, which now
// comes from the local ./spec-types.js rather than "@kampong/spec" (this
// project has no dependency on that package -- ADR-0002). From here on this
// file is yours: it will not be touched again by a future export.
//
// The front-end-agnostic run controller: wraps the workflow generator
// behind a `start`/`resume` API and a `pendingApproval` state, so a stdin
// prompt (src/index.ts in this project) can drive the engine without the
// engine itself knowing anything about how approval is collected.

import { EventEmitter } from "node:events";
import type { AgentSpec } from "./spec-types.js";
import { createMastraModelClient, type ModelClient } from "./model.js";
import { runWorkflow, type ApprovalDecision, type EngineDeps, type RunEvent } from "./workflow.js";

export type RunStatus = "running" | "awaiting_approval" | "completed" | "rejected" | "failed";

export interface PendingApproval {
  step: string;
  kind: "tool" | "guardrail";
  reason: string;
  toolName?: string;
}

export interface StepRecord {
  step: string;
  status: "completed" | "failed";
  output?: unknown;
  confidence?: number;
  error?: string;
}

export interface RunState {
  status: RunStatus;
  trace: StepRecord[];
  pendingApproval?: PendingApproval;
  finalOutput?: Record<string, unknown>;
  error?: string;
}

function initialState(): RunState {
  return { status: "running", trace: [] };
}

export class AgentRun extends EventEmitter {
  private generator: AsyncGenerator<RunEvent, void, ApprovalDecision | undefined> | null = null;
  private state: RunState = initialState();

  constructor(
    private readonly spec: AgentSpec,
    private readonly deps: EngineDeps,
  ) {
    super();
  }

  getState(): RunState {
    return this.state;
  }

  /** Begins the run; resolves once it reaches its first pause point (a step's approval gate, completion, rejection, or failure). */
  async start(input: string): Promise<RunState> {
    if (this.generator) {
      throw new Error(
        "This AgentRun has already been started; create a new AgentRun to run again.",
      );
    }
    this.generator = runWorkflow(this.spec, this.deps, input);
    return this.advance(undefined);
  }

  /** Resolves the pending approval (tool- or guardrail-triggered) and resumes until the next pause point. */
  async resume(approved: boolean, reason?: string): Promise<RunState> {
    if (!this.generator || this.state.status !== "awaiting_approval") {
      throw new Error("resume() called but this run has no pending approval.");
    }
    // Flip the status synchronously, before the `await` inside advance(),
    // so the guard above is atomic: a second concurrent resume()/approve()
    // call on this same run sees a non-"awaiting_approval" status right
    // away and throws instead of racing to deliver its decision to
    // whatever the *next* yield point turns out to be.
    this.state = { ...this.state, status: "running" };
    return this.advance({ approved, reason });
  }

  private async advance(input: ApprovalDecision | undefined): Promise<RunState> {
    const generator = this.generator;
    if (!generator) {
      throw new Error("This AgentRun has not been started yet.");
    }

    const { value, done } = await generator.next(input);
    if (done) return this.state;

    this.applyEvent(value);
    this.emit("event", value);

    if (value.type === "step_started" || value.type === "step_completed") {
      return this.advance(undefined);
    }
    return this.state;
  }

  private applyEvent(event: RunEvent): void {
    switch (event.type) {
      case "step_started":
        this.state = { ...this.state, status: "running" };
        break;
      case "step_completed":
        this.state = {
          ...this.state,
          status: "running",
          pendingApproval: undefined,
          trace: [
            ...this.state.trace,
            {
              step: event.step,
              status: "completed",
              output: event.output,
              confidence: event.confidence,
            },
          ],
        };
        break;
      case "awaiting_approval":
        this.state = {
          ...this.state,
          status: "awaiting_approval",
          pendingApproval: {
            step: event.step,
            kind: event.kind,
            reason: event.reason,
            toolName: event.toolName,
          },
        };
        break;
      case "completed":
        this.state = {
          ...this.state,
          status: "completed",
          finalOutput: event.output,
          pendingApproval: undefined,
        };
        break;
      case "rejected":
        this.state = {
          ...this.state,
          status: "rejected",
          error: event.reason,
          pendingApproval: undefined,
          trace: [...this.state.trace, { step: event.step, status: "failed", error: event.reason }],
        };
        break;
      case "failed":
        this.state = {
          ...this.state,
          status: "failed",
          error: event.error,
          pendingApproval: undefined,
          trace: event.step
            ? [...this.state.trace, { step: event.step, status: "failed", error: event.error }]
            : this.state.trace,
        };
        break;
    }
  }
}

export interface CreateAgentRunOptions {
  env?: NodeJS.ProcessEnv;
  model?: ModelClient;
  /** Overrides the fetch used for HTTP *tool* calls. */
  fetchImpl?: EngineDeps["fetchImpl"];
  /** Overrides the fetch the *model* provider (e.g. the Ollama adapter) uses internally. Distinct from `fetchImpl` above -- tool calls and model calls are separate network seams. */
  modelFetchImpl?: typeof fetch;
}

/**
 * Convenience factory: resolves BYOK env vars and constructs the real
 * Mastra-backed model client synchronously (so a missing/invalid API key
 * surfaces immediately, before a run even starts), unless a fake
 * `ModelClient` is injected.
 */
export function createAgentRun(spec: AgentSpec, options: CreateAgentRunOptions = {}): AgentRun {
  const model =
    options.model ??
    createMastraModelClient(spec, options.env ?? process.env, {
      fetchImpl: options.modelFetchImpl,
    });
  return new AgentRun(spec, { model, fetchImpl: options.fetchImpl });
}
