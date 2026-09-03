import { randomUUID } from "node:crypto";
import { AgentRun, createAgentRun, type ModelClient, type RunState } from "@kampong/engine";
import type { AgentSpec } from "@kampong/spec";

// Holds the in-flight test runs `kampong dev`'s server exposes over HTTP
// (PLAN.md Shape S5, SLICES.md V2 KAN-1107). Runs are process-local and
// in-memory -- there's no run-history store in this slice (PLAN.md's
// "Local run-history log" affordance is unbuilt scaffolding, not this
// slice's scope) -- so a server restart drops any run still in flight.

export interface StartRunResult {
  id: string;
  state: RunState;
}

export interface RunManagerOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Test-only seam: overrides real BYOK/Mastra model resolution with a fake ModelClient. */
  createModel?: (spec: AgentSpec) => ModelClient;
}

export class RunManager {
  private readonly runs = new Map<string, AgentRun>();

  constructor(private readonly options: RunManagerOptions = {}) {}

  async start(spec: AgentSpec, input: string): Promise<StartRunResult> {
    const id = randomUUID();
    const run = createAgentRun(spec, {
      env: this.options.env,
      fetchImpl: this.options.fetchImpl,
      model: this.options.createModel?.(spec),
    });
    this.runs.set(id, run);
    const state = await run.start(input);
    return { id, state };
  }

  get(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  async approve(id: string, approved: boolean, reason?: string): Promise<RunState | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    return run.resume(approved, reason);
  }
}
