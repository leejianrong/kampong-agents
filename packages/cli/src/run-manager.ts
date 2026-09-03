import { randomUUID } from "node:crypto";
import {
  AgentRun,
  createAgentRun,
  type ModelClient,
  type RunEvent,
  type RunState,
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
  state: RunState;
}

export interface RunManagerOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
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
    const state = await run.start(input);
    return { id, state };
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
