import { EventEmitter } from "node:events";
import type { AgentSpec } from "@kampong/spec";
import { createMastraModelClient, type ModelClient } from "./model.js";
import type { StateStore } from "./state-store.js";
import {
  runWorkflow,
  type ApprovalDecision,
  type ApprovalFailureCode,
  type EngineDeps,
  type RunEvent,
} from "./workflow.js";

// The front-end-agnostic run controller (PLAN.md Shape S3, SLICES.md V2
// KAN-1104/1107): wraps the workflow generator behind a `start`/`resume`
// API and a `pendingApproval` state, so a browser modal (in scope this
// slice) and a future CLI stdin prompt (V3, out of scope) can drive the
// exact same engine without either one being baked into this class.

export type RunStatus = "running" | "awaiting_approval" | "completed" | "rejected" | "failed";

export interface PendingApproval {
  step: string;
  // "approval" is a first-class approval step (KAN-1429); "tool"/"guardrail"
  // are the pre-existing implicit pauses. Mirrors RunEvent's awaiting_approval
  // kind in workflow.ts.
  kind: "tool" | "guardrail" | "approval";
  reason: string;
  toolName?: string;
  /** Correlation key of the persisted record (KAN-1854): resolve it from any process with `resumeApproval`. Set only when the run persists approvals. */
  key?: string;
}

export interface StepRecord {
  step: string;
  status: "completed" | "rejected" | "failed";
  output?: unknown;
  confidence?: number;
  error?: string;
}

export interface RunState {
  status: RunStatus;
  trace: StepRecord[];
  pendingApproval?: PendingApproval;
  finalOutput?: Record<string, unknown>;
  /** Set on a completed run that a `validate` (on_fail: skip) or `dedupe` step ended early (KAN-1860). */
  skipped?: { step: string; reason: string };
  error?: string;
  /** Set when resolving a persisted approval by key failed for a known reason (KAN-1854). */
  errorCode?: ApprovalFailureCode;
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

  /**
   * Resolves a persisted pending approval by its key, in this process or any other that shares the store
   * and the spec (KAN-1854, ADR-0042). Use it on a fresh AgentRun instead of `start`. It claims the
   * record, so a second caller for the same key gets a failed run ("already resolved"), then resumes at
   * the paused step with the stored outputs and input; a rejection ends the run as rejected. A spec that
   * changed since the pause fails the run and leaves the record. Resolves at the next pause point.
   */
  async resumeByKey(key: string, approved: boolean, reason?: string): Promise<RunState> {
    if (this.generator) {
      throw new Error(
        "This AgentRun has already been started; create a new AgentRun to resume an approval.",
      );
    }
    this.generator = runWorkflow(this.spec, this.deps, "", { key, decision: { approved, reason } });
    return this.advance(undefined);
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
            ...(event.key !== undefined && { key: event.key }),
          },
        };
        break;
      case "completed":
        this.state = {
          ...this.state,
          status: "completed",
          finalOutput: event.output,
          ...(event.skipped && { skipped: event.skipped }),
          pendingApproval: undefined,
        };
        break;
      case "rejected":
        this.state = {
          ...this.state,
          status: "rejected",
          error: event.reason,
          pendingApproval: undefined,
          trace: [
            ...this.state.trace,
            { step: event.step, status: "rejected", error: event.reason },
          ],
        };
        break;
      case "failed":
        this.state = {
          ...this.state,
          status: "failed",
          error: event.error,
          ...(event.code && { errorCode: event.code }),
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
  /** Overrides the fetch used for HTTP *tool* calls -- e.g. the mock/record layer's createFixtureFetch (V3 KAN-1111). */
  fetchImpl?: EngineDeps["fetchImpl"];
  /** Records or replays module component ops (KAN-1833); the `kampong run --tools` counterpart of `fetchImpl`. */
  moduleFixtures?: EngineDeps["moduleFixtures"];
  /** Tool pacing and retry delays (KAN-1846); the CLI passes an instant clock when replaying fixtures. */
  toolPacer?: EngineDeps["pacer"];
  toolClock?: EngineDeps["clock"];
  /**
   * Overrides the fetch the *model* provider (e.g. the Ollama adapter, V3
   * KAN-1112) uses internally. Distinct from `fetchImpl` above -- tool
   * calls and model calls are separate network seams -- and mainly a test
   * seam: it's what lets `e2e/`'s fully-offline test (KAN-1113) exercise
   * the real `ollama` provider-resolution path with a canned response
   * instead of a live Ollama server, while proving nothing falls back to
   * the global `fetch`.
   */
  modelFetchImpl?: typeof fetch;
  /**
   * CLI override (`kampong run --timeout <ms>`, KAN-1185): forwarded
   * straight through to `createMastraModelClient`, where it takes
   * precedence over `agent.model.timeout_ms` on the spec. Ignored when a
   * fake `model` (below) is injected instead of building the real one.
   */
  timeoutMs?: number;
  /** Runs `action: component` tools (KAN-1884); see createComponentDispatcher. */
  components?: EngineDeps["components"];
  /** What started the run (a webhook's headers and body); version 1.1 expressions read it as `trigger`. */
  trigger?: EngineDeps["trigger"];
  /** Values for the spec's `vars` that win over their defaults. */
  vars?: EngineDeps["vars"];
  /** Overrides the expression evaluator's limits. */
  expressionLimits?: EngineDeps["expressionLimits"];
  /** The store `dedupe` steps use (KAN-1860). The caller owns it. Wins over `statePath`. */
  state?: EngineDeps["state"];
  /**
   * Where the default SQLite store lives, when the spec has a `dedupe` step and no `state` is given.
   * Defaults to `.kampong/state.db` in the working directory. The file is not created for a spec without one.
   */
  statePath?: string;
  /** Persist a record whenever the run pauses for approval, so it can be resolved by key from any process (KAN-1854, ADR-0042). Uses `state`, else the SQLite store at `statePath`. Off by default. */
  persistApprovals?: boolean;
  /** How long a persisted approval stays resolvable; default 7 days. */
  approvalTtlMs?: number;
  /** Clock for persisted-record timestamps (tests). */
  now?: EngineDeps["now"];
}

/**
 * Convenience factory: resolves BYOK env vars and constructs the real
 * Mastra-backed model client synchronously (so a missing/invalid API key
 * surfaces immediately, before a run even starts), unless a fake
 * `ModelClient` is injected (tests -- KAN-1108's guardrail integration test
 * and packages/cli's server tests use this to avoid any live network call).
 */
export function createAgentRun(spec: AgentSpec, options: CreateAgentRunOptions = {}): AgentRun {
  const model =
    options.model ??
    createMastraModelClient(spec, options.env ?? process.env, {
      fetchImpl: options.modelFetchImpl,
      timeoutMs: options.timeoutMs,
    });
  return new AgentRun(spec, {
    model,
    fetchImpl: options.fetchImpl,
    moduleFixtures: options.moduleFixtures,
    pacer: options.toolPacer,
    clock: options.toolClock,
    components: options.components,
    trigger: options.trigger,
    vars: options.vars,
    expressionLimits: options.expressionLimits,
    // The opener is lazy: the file is created only when a dedupe step is reached or an approval is
    // persisted or resumed, never for a run that does neither.
    ...(options.state
      ? { state: options.state }
      : { openState: () => openDefaultStateStore(options.statePath) }),
    ...(options.persistApprovals && { persistApprovals: true }),
    ...(options.approvalTtlMs !== undefined && { approvalTtlMs: options.approvalTtlMs }),
    ...(options.now && { now: options.now }),
    // KAN-1430: connector `${ENV}` tokens resolve from the same env the model
    // key does (process.env by default), so an exported/deployed app just sets
    // e.g. SLACK_BOT_TOKEN in its environment.
    env: options.env ?? process.env,
  });
}

// A dynamic import, so the SQLite module (node:sqlite) is loaded only by a run that opens a store, not
// by everything that imports the engine.
async function openDefaultStateStore(path: string | undefined): Promise<StateStore> {
  const { SqliteStateStore } = await import("./sqlite-state-store.js");
  return new SqliteStateStore(path === undefined ? {} : { path });
}
