import { randomUUID } from "node:crypto";
import {
  AgentRun,
  createAgentRun,
  type ModelClient,
  type RunEvent,
  type RunState,
  type ToolFetchImpl,
} from "@kampong/engine";
import type { AgentSpec } from "@kampong/spec";

// Holds the in-flight test runs `kampong dev`'s server exposes over HTTP
// (PLAN.md Shape S5, SLICES.md V2 KAN-1107). Runs are process-local and
// in-memory -- there's no run-history store in this slice (PLAN.md's
// "Local run-history log" affordance is unbuilt scaffolding, not this
// slice's scope) -- so a server restart drops any run still in flight.

// A `kampong dev` session can run for hours; without eviction, `runs` would
// grow by one entry per test-run for the life of the process. Terminal runs
// (nothing left to poll or approve) are dropped a short while after they
// finish -- long enough for a slow client to still read the final state,
// short enough that this stays a bounded cache rather than a run-history
// store (out of scope, see above).
const DEFAULT_EVICT_AFTER_MS = 10 * 60 * 1000;

const TERMINAL_EVENT_TYPES: ReadonlySet<RunEvent["type"]> = new Set([
  "completed",
  "rejected",
  "failed",
]);

export interface StartRunResult {
  id: string;
  /** The run's state at the moment it was registered -- always `{ status: "running", trace: [] }` (KAN-1187). Callers drive all further state off the run's "event" stream (e.g. the `/api/runs/:id/events` SSE route), not this snapshot. */
  state: RunState;
}

export interface RunManagerOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: ToolFetchImpl;
  /** Test-only seam: overrides real BYOK/Mastra model resolution with a fake ModelClient. */
  createModel?: (spec: AgentSpec) => ModelClient;
  /** Test-only seam: how long a terminal run stays in `runs` before eviction (default 10 minutes). */
  evictAfterMs?: number;
}

export class RunManager {
  private readonly runs = new Map<string, AgentRun>();
  private readonly evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly evictAfterMs: number;

  constructor(private readonly options: RunManagerOptions = {}) {
    this.evictAfterMs = options.evictAfterMs ?? DEFAULT_EVICT_AFTER_MS;
  }

  // KAN-1187: this used to `await run.start(input)` before returning, but
  // AgentRun.start() (packages/engine) only resolves once the workflow's
  // async generator reaches its FIRST pause/terminal yield (an
  // awaiting_approval/completed/rejected/failed event) -- never on the very
  // first step_started. Awaiting it here meant POST /api/runs itself
  // blocked for that same duration, so the canvas couldn't even learn the
  // run's id -- and therefore couldn't open its per-run SSE subscription --
  // until the run was already paused or done. For a single-step workflow
  // (the common case) that made the entire run invisible while in flight.
  // The fix: register the run and kick off run.start() without awaiting
  // it, and return immediately with the id and the run's untouched initial
  // state ("running", empty trace). Every event from that point on --
  // including the first step_started -- is driven purely by the AgentRun's
  // "event" emitter, which server.ts's /api/runs/:id/events SSE route (and
  // this class's own eviction hook, below) already subscribe to.
  async start(spec: AgentSpec, input: string): Promise<StartRunResult> {
    const id = randomUUID();
    const run = createAgentRun(spec, {
      env: this.options.env,
      fetchImpl: this.options.fetchImpl,
      model: this.options.createModel?.(spec),
    });
    run.on("event", (event: RunEvent) => {
      if (TERMINAL_EVENT_TYPES.has(event.type)) this.scheduleEviction(id);
    });
    this.runs.set(id, run);
    // Fire-and-forget: workflow.ts (packages/engine) already catches every
    // real failure mode itself and yields a "failed" RunEvent instead of
    // throwing, so a rejection here means something broke unexpectedly
    // upstream of that. Logging (rather than silently swallowing it) keeps
    // that visible without turning it into an unhandled rejection that
    // could crash the `kampong dev` process.
    run.start(input).catch((err: unknown) => {
      console.error(`Run ${id} failed unexpectedly:`, err);
    });
    return { id, state: run.getState() };
  }

  get(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  /** Resolves a pending approval by run id -- the one place both the HTTP route and eviction bookkeeping route through. */
  async approve(id: string, approved: boolean, reason?: string): Promise<RunState | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    return run.resume(approved, reason);
  }

  private scheduleEviction(id: string): void {
    const existing = this.evictionTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.runs.delete(id);
      this.evictionTimers.delete(id);
    }, this.evictAfterMs);
    // Never keep a `kampong dev` process alive just for eviction bookkeeping.
    timer.unref?.();
    this.evictionTimers.set(id, timer);
  }
}
