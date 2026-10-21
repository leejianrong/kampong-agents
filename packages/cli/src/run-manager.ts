import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  AgentRun,
  createAgentRun,
  DEFAULT_STATE_DB_PATH,
  listPendingApprovals,
  SqliteStateStore,
  type PersistedApproval,
  postApprovalRequest,
  resolveEnvValue,
  SlackApiError,
  type ComponentDispatcher,
  type ModelClient,
  type RunEvent,
  type RunState,
  type StateStore,
  type ToolFetchImpl,
} from "@kampong/engine";
import type { AgentSpec } from "@kampong/spec";
import type { ReplayDeps } from "./run-options.js";

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
  /** Runs `action: component` tools; the servers default it to the spec's `components/` folder. */
  components?: ComponentDispatcher;
  /** Test-only seam: overrides real BYOK/Mastra model resolution with a fake ModelClient. */
  createModel?: (spec: AgentSpec) => ModelClient;
  /** Test-only seam: how long a terminal run stays in `runs` before eviction (default 10 minutes). */
  evictAfterMs?: number;
  /**
   * KAN-1432 (ADR-0021 Slice D): when true, a run that pauses for approval
   * with a `spec.agent.approval_notifier` configured posts an interactive
   * Approve/Reject Slack message instead of relying on someone watching a
   * UI. Off by default -- `kampong dev`'s canvas server never sets this
   * (the canvas *is* the approval UI; a test-run there shouldn't also spam
   * Slack), only the headless paths (`kampong serve`, the exported app) do.
   */
  notifyApprovalsViaSlack?: boolean;
  /** Test-only seam: overrides the fetch used for the outbound Slack API calls above (distinct from `fetchImpl`, which is for tool calls). Defaults to the real `fetch`. */
  slackFetchImpl?: typeof fetch;
  /**
   * KAN-1854 (ADR-0042): a run that pauses for approval writes a record to the state store, so it can be
   * resolved by its key after a restart or from another process. Off by default (`kampong dev` keeps its
   * in-memory runs); `kampong serve` turns it on. Needs `spec` to resume a record no run in this process owns.
   */
  persistApprovals?: boolean;
  /** The spec that records are resumed under when no in-memory run owns the key (`kampong serve` serves one). */
  spec?: AgentSpec;
  /** The store to persist to. Defaults to the SQLite file at `statePath`. The caller owns it. */
  state?: StateStore;
  /** Where the default SQLite store lives (default `.kampong/state.db` in the working directory). */
  statePath?: string;
  /** How long a persisted approval stays resolvable (default 7 days). */
  approvalTtlMs?: number;
}

/** How long a `respond: sync` webhook waits for the run before answering with its id (KAM-109). */
export const DEFAULT_SYNC_TIMEOUT_MS = 30_000;

export interface SyncAnswer {
  code: number;
  body: Record<string, unknown>;
}

/**
 * What a `respond: sync` webhook answers once the run has settled or its timeout passed: the final output
 * when it completed (200), the error when it failed (500) or was rejected (409), and otherwise (202) the run
 * id to poll, because a run waiting for approval or still running cannot answer yet. The run carries on.
 */
export function syncAnswer(id: string, state: RunState): SyncAnswer {
  switch (state.status) {
    case "completed":
      return { code: 200, body: { success: true, id, output: state.finalOutput, state } };
    case "failed":
      return { code: 500, body: { success: false, id, error: state.error, state } };
    case "rejected":
      return {
        code: 409,
        body: { success: false, id, error: state.error ?? "The run was rejected.", state },
      };
    case "awaiting_approval":
      return { code: 202, body: { success: true, id, pending: "approval", state } };
    default:
      return { code: 202, body: { success: true, id, pending: "timeout", state } };
  }
}

/** A webhook request that was accepted but did not start a run, because the trigger's `when` was false (KAN-1848). */
export interface IgnoredTrigger {
  at: string;
  reason: string;
}
const MAX_IGNORED = 100;

export class RunManager {
  private readonly runs = new Map<string, AgentRun>();
  private readonly ignored: IgnoredTrigger[] = [];
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
  async start(
    spec: AgentSpec,
    input: string,
    trigger?: { headers?: Record<string, string>; fields?: Record<string, unknown> },
    /** KAM-188: `replay` answers tool and model calls from recorded fixtures instead of the real services. */
    replay?: ReplayDeps,
    /** KAM-191: values for the spec's `vars` for this run only, winning over their defaults (`kampong run --var`). */
    vars?: Record<string, unknown>,
  ): Promise<StartRunResult> {
    const run = this.createRun(spec, trigger, replay, vars);
    const id = this.register(spec, run);
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

  /** Records a request the trigger's `when` filtered out: it is recorded as ignored, never as a run. */
  recordIgnored(reason: string): void {
    this.ignored.push({ at: new Date().toISOString(), reason });
    if (this.ignored.length > MAX_IGNORED) this.ignored.shift();
  }

  /** The most recent ignored requests, oldest first (the last 100). */
  listIgnored(): IgnoredTrigger[] {
    return [...this.ignored];
  }

  private createRun(
    spec: AgentSpec,
    trigger?: { headers?: Record<string, string>; fields?: Record<string, unknown> },
    replay?: ReplayDeps,
    vars?: Record<string, unknown>,
  ): AgentRun {
    return createAgentRun(spec, {
      env: this.options.env,
      fetchImpl: this.options.fetchImpl,
      components: this.options.components,
      model: this.options.createModel?.(spec),
      ...(replay ? replay : {}),
      ...(vars && Object.keys(vars).length > 0 ? { vars } : {}),
      ...(trigger ? { trigger } : {}),
      ...(this.options.persistApprovals
        ? {
            persistApprovals: true,
            ...(this.options.state ? { state: this.options.state } : {}),
            ...(this.options.statePath ? { statePath: this.options.statePath } : {}),
            ...(this.options.approvalTtlMs !== undefined
              ? { approvalTtlMs: this.options.approvalTtlMs }
              : {}),
          }
        : {}),
    });
  }

  /** Adds a run to the map under a fresh id and wires its eviction and Slack notification hooks. */
  private register(spec: AgentSpec, run: AgentRun): string {
    const id = randomUUID();
    run.on("event", (event: RunEvent) => {
      if (TERMINAL_EVENT_TYPES.has(event.type)) this.scheduleEviction(id);
    });
    if (this.options.notifyApprovalsViaSlack && spec.agent.approval_notifier) {
      const notifier = spec.agent.approval_notifier;
      run.on("event", (event: RunEvent) => {
        if (event.type !== "awaiting_approval") return;
        const env = this.options.env ?? process.env;
        // Fire-and-forget, same reasoning as run.start().catch below: a
        // Slack API/network failure here must not crash the run or the
        // server process, but it must not be silently invisible either.
        Promise.resolve()
          .then(() => resolveEnvValue(notifier.token, env))
          .then((token) =>
            postApprovalRequest(
              { token, channel: notifier.channel, runId: event.key ?? id, text: event.reason },
              this.options.slackFetchImpl,
            ),
          )
          .catch((err: unknown) => {
            const detail = err instanceof SlackApiError ? err.message : (err as Error).message;
            console.error(`Run ${id}: failed to post Slack approval notification: ${detail}`);
          });
      });
    }
    this.runs.set(id, run);
    return id;
  }

  /**
   * Resolves with the run's state once it is no longer `running` (completed, failed, rejected, or paused for
   * approval) or after `timeoutMs`, whichever comes first. Never stops the run.
   */
  async settle(id: string, timeoutMs: number): Promise<RunState | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (run.getState().status !== "running") return run.getState();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        run.off("event", check);
        resolve(run.getState());
      };
      const check = () => {
        if (run.getState().status !== "running") finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      run.on("event", check);
    });
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

  /**
   * Resolves a pending approval by run id or by its persisted correlation key (KAN-1854, ADR-0042).
   * A run this process owns, found by id or by its pending key, resumes in place. Otherwise, with
   * persistence on, the key is loaded from the store and the run continues in a new run registered
   * under a fresh id (the one in the result), which is how an approval survives a restart. An unknown
   * key resolves to a failed state with `errorCode: "approval_not_found"`; without persistence an
   * unknown id resolves to undefined as `approve` does.
   */
  async resolveApproval(
    idOrKey: string,
    approved: boolean,
    reason?: string,
  ): Promise<{ id: string; state: RunState } | undefined> {
    const owned = this.runs.has(idOrKey)
      ? idOrKey
      : [...this.runs].find(([, r]) => r.getState().pendingApproval?.key === idOrKey)?.[0];
    if (owned)
      return { id: owned, state: (await this.approve(owned, approved, reason)) as RunState };
    const { spec } = this.options;
    if (!this.options.persistApprovals || !spec) return undefined;
    const run = this.createRun(spec);
    const id = this.register(spec, run);
    const state = await run.resumeByKey(idOrKey, approved, reason);
    return { id, state };
  }

  /**
   * The approvals waiting in the store, oldest first, whichever process paused them. Empty when persistence
   * is off or the default store file does not exist yet (listing never creates it).
   */
  async listPendingApprovals(): Promise<PersistedApproval[]> {
    if (!this.options.persistApprovals) return [];
    if (this.options.state) return listPendingApprovals(this.options.state);
    const path = this.options.statePath ?? DEFAULT_STATE_DB_PATH;
    if (!existsSync(path)) return [];
    const store = new SqliteStateStore({ path });
    try {
      return await listPendingApprovals(store);
    } finally {
      await store.close();
    }
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
