import { and, eq } from "drizzle-orm";
import {
  createAgentRun,
  type AgentRun,
  type ModelClient,
  type RunEvent,
  type RunState,
  type ToolFetchImpl,
} from "@kampong/engine";
import { parseSpec, type AgentSpec } from "@kampong/spec";
import type { DbClient } from "../db/client.js";
import { withWorkspaceScope } from "../db/workspace-scope.js";
import { runs, specs } from "../db/schema.js";
import { resolveWorkspaceModelClient } from "../model/resolve.js";
import { SpecNotFoundError } from "../db/spec-repository.js";

// KAN-1231 (ADR-0014): the hosted, durable successor to packages/cli's
// in-memory `RunManager`. A run is BOTH a live in-memory `AgentRun` (an
// EventEmitter the SSE/approval routes need to hold onto -- wired in a
// follow-up) AND a persisted `runs` row that survives a server restart, so a
// user can return to see a past run's full trace (ADR-0014's reason for
// durability over the local in-memory-only design). Every tenant read/write
// here goes through `withWorkspaceScope`, so RLS on `runs`
// (drizzle/0009_enable_runs_rls.sql) isolates one workspace's runs from
// another's exactly like specs/byok_keys.
//
// The engine is reused entirely unchanged: `createAgentRun`/`runWorkflow`
// produce the same `RunState`/`RunEvent` the CLI already drives its UI off
// of; this class just resolves the model client per workspace (KAN-1230) and
// persists the state the engine emits, rather than holding it only in memory.

const TERMINAL_STATUSES: ReadonlySet<RunState["status"]> = new Set([
  "completed",
  "rejected",
  "failed",
]);
const TERMINAL_EVENT_TYPES: ReadonlySet<RunEvent["type"]> = new Set([
  "completed",
  "rejected",
  "failed",
]);
const DEFAULT_EVICT_AFTER_MS = 10 * 60 * 1000;

export class InvalidStoredSpecError extends Error {
  constructor(specId: string) {
    super(`Stored spec "${specId}" could not be parsed into a runnable AgentSpec.`);
    this.name = "InvalidStoredSpecError";
  }
}

export interface HostedRunManagerOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: ToolFetchImpl;
  /**
   * Test-only seam (mirrors packages/cli's `RunManagerOptions.createModel`):
   * bypasses the real per-workspace BYOK/LiteLLM resolution
   * (`resolveWorkspaceModelClient`) with a fake `ModelClient`, so run-lifecycle
   * behavior is exercised deterministically with no network and no stored key.
   */
  createModel?: (spec: AgentSpec) => ModelClient | Promise<ModelClient>;
  /** Test-only seam: how long a terminal run stays in the live map before eviction (default 10 minutes). */
  evictAfterMs?: number;
}

export interface StartRunResult {
  id: string;
  state: RunState;
}

export class HostedRunManager {
  private readonly live = new Map<string, AgentRun>();
  private readonly evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Per-run serialized persist tail: run events fire faster than a DB write
  // completes, so chain each run's writes to guarantee the terminal state is
  // the last one persisted (a late earlier write could otherwise clobber it).
  private readonly persistTails = new Map<string, Promise<void>>();
  private readonly evictAfterMs: number;

  constructor(
    private readonly db: DbClient,
    private readonly options: HostedRunManagerOptions = {},
  ) {
    this.evictAfterMs = options.evictAfterMs ?? DEFAULT_EVICT_AFTER_MS;
  }

  /**
   * Starts a run of workspace `workspaceId`'s spec `specId` server-side.
   * Persists the run's initial row, resolves the workspace's model client,
   * and kicks the run off (fire-and-forget, like the CLI's RunManager),
   * persisting the run state after every event. Returns immediately with the
   * durable run id and its initial state; callers drive further updates off
   * `get()` (and, once wired, the SSE stream).
   *
   * Throws `SpecNotFoundError` if the spec isn't in this workspace, and
   * whatever `resolveWorkspaceModelClient` throws (e.g.
   * `WorkspaceApiKeyNotConfiguredError`) when the model client can't be built.
   */
  async start(workspaceId: string, specId: string, input: string): Promise<StartRunResult> {
    const source = await withWorkspaceScope(this.db, workspaceId, async (tx) => {
      const [row] = await tx
        .select({ yamlSource: specs.yamlSource })
        .from(specs)
        .where(and(eq(specs.id, specId), eq(specs.workspaceId, workspaceId)));
      return row?.yamlSource;
    });
    if (source === undefined) {
      throw new SpecNotFoundError(specId, workspaceId);
    }

    const parsed = parseSpec(source);
    if (!parsed.success || !parsed.spec) {
      throw new InvalidStoredSpecError(specId);
    }
    const spec = parsed.spec as AgentSpec;

    const model = this.options.createModel
      ? await this.options.createModel(spec)
      : await resolveWorkspaceModelClient({
          db: this.db,
          workspaceId,
          spec,
          env: this.options.env,
        });

    const run = createAgentRun(spec, {
      model,
      env: this.options.env,
      fetchImpl: this.options.fetchImpl,
    });
    const initialState = run.getState();

    const id = await withWorkspaceScope(this.db, workspaceId, async (tx) => {
      const [row] = await tx
        .insert(runs)
        .values({
          workspaceId,
          specId,
          input,
          status: initialState.status,
          traceJson: initialState.trace,
        })
        .returning({ id: runs.id });
      return row!.id;
    });

    this.live.set(id, run);
    run.on("event", (event: RunEvent) => {
      this.enqueuePersist(workspaceId, id, run.getState());
      if (TERMINAL_EVENT_TYPES.has(event.type)) this.scheduleEviction(id);
    });

    // Fire-and-forget (workflow.ts already converts every real failure into a
    // "failed" RunEvent, so a rejection here is genuinely unexpected -- log,
    // don't crash the server).
    run.start(input).catch((err: unknown) => {
      console.error(`Hosted run ${id} failed unexpectedly:`, err);
    });

    return { id, state: initialState };
  }

  /**
   * Returns a run's current state, or `undefined` if no such run exists IN
   * THIS WORKSPACE. Ownership is confirmed by a workspace-scoped `runs` read
   * FIRST (so RLS gates it) -- the in-memory `live` map is keyed only by run
   * id and holds every workspace's in-flight runs, so returning a live run's
   * state without that check would leak another workspace's run. Once
   * ownership is confirmed, a resident live run's state is preferred (it's the
   * freshest, ahead of the async persist); otherwise the persisted row is
   * reconstructed.
   */
  async get(workspaceId: string, id: string): Promise<RunState | undefined> {
    const [row] = await withWorkspaceScope(this.db, workspaceId, (tx) =>
      tx
        .select()
        .from(runs)
        .where(and(eq(runs.id, id), eq(runs.workspaceId, workspaceId))),
    );
    if (!row) return undefined;

    const liveRun = this.live.get(id);
    if (liveRun) return liveRun.getState();
    return {
      status: row.status as RunState["status"],
      trace: row.traceJson as RunState["trace"],
      finalOutput: (row.finalOutput as RunState["finalOutput"]) ?? undefined,
      error: row.error ?? undefined,
    };
  }

  private enqueuePersist(workspaceId: string, id: string, state: RunState): void {
    const prev = this.persistTails.get(id) ?? Promise.resolve();
    const next = prev
      .then(() => this.persist(workspaceId, id, state))
      .catch((err: unknown) => {
        console.error(`Persisting hosted run ${id} failed:`, err);
      });
    this.persistTails.set(id, next);
  }

  private async persist(workspaceId: string, id: string, state: RunState): Promise<void> {
    const terminal = TERMINAL_STATUSES.has(state.status);
    await withWorkspaceScope(this.db, workspaceId, (tx) =>
      tx
        .update(runs)
        .set({
          status: state.status,
          traceJson: state.trace,
          finalOutput: state.finalOutput ?? null,
          error: state.error ?? null,
          completedAt: terminal ? new Date() : null,
        })
        .where(and(eq(runs.id, id), eq(runs.workspaceId, workspaceId))),
    );
  }

  private scheduleEviction(id: string): void {
    const existing = this.evictionTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.live.delete(id);
      this.evictionTimers.delete(id);
      this.persistTails.delete(id);
    }, this.evictAfterMs);
    timer.unref?.();
    this.evictionTimers.set(id, timer);
  }
}
