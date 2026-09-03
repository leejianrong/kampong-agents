import { EventEmitter } from "node:events";
import type { AgentSpec } from "@kampong/spec";
import { createMastraModelClient, type ModelClient } from "./model.js";
import { runWorkflow, type ApprovalDecision, type EngineDeps, type RunEvent } from "./workflow.js";

// The front-end-agnostic run controller (PLAN.md Shape S3, SLICES.md V2
// KAN-1104/1107): wraps the workflow generator behind a `start`/`resume`
// API and a `pendingApproval` state, so a browser modal (in scope this
// slice) and a future CLI stdin prompt (V3, out of scope) can drive the
// exact same engine without either one being baked into this class.

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
  fetchImpl?: EngineDeps["fetchImpl"];
}

/**
 * Convenience factory: resolves BYOK env vars and constructs the real
 * Mastra-backed model client synchronously (so a missing/invalid API key
 * surfaces immediately, before a run even starts), unless a fake
 * `ModelClient` is injected (tests -- KAN-1108's guardrail integration test
 * and packages/cli's server tests use this to avoid any live network call).
 */
export function createAgentRun(spec: AgentSpec, options: CreateAgentRunOptions = {}): AgentRun {
  const model = options.model ?? createMastraModelClient(spec, options.env ?? process.env);
  return new AgentRun(spec, { model, fetchImpl: options.fetchImpl });
}
