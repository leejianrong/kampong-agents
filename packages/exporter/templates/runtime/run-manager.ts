// Hand-vendored from packages/cli/src/run-manager.ts as part of a `kampong
// export` (KAN-1435, ADR-0021/ADR-0022) -- see
// docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. Unlike the
// packages/engine/src/*.ts files vendored alongside this one, this file's
// source package is packages/cli, not packages/engine -- and the exported
// project has no dependency on @kampong/cli either (ADR-0002), so its value
// imports (AgentRun, createAgentRun) are rewritten from the "@kampong/engine"
// package to the local ./run.js runtime module, not merely a type-only import
// whose module specifier vanishes on transpilation. That is a real,
// permanent code change (not the comments/type-import-only drift
// runtime-parity.test.ts's byte/functional check tolerates for the
// packages/engine-sourced files), which is why this file is a documented
// HAND_VENDORED_EXEMPTIONS entry there instead. From here on this file is
// yours: it will not be touched again by a future export.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { AgentRun, createAgentRun, type RunState } from "./run.js";
import { listPendingApprovals, type PersistedApproval } from "./pending-approval.js";
import type { StateStore } from "./state-store.js";
import { postApprovalRequest, SlackApiError } from "./slack-approval.js";
import { resolveEnvValue } from "./http-tool.js";
import type { ModelClient } from "./model.js";
import type { ToolFetchImpl } from "./http-tool.js";
import type { ComponentDispatcher, RunEvent } from "./workflow.js";
import type { AgentSpec } from "./spec-types.js";

// Holds the in-flight runs the exported project's webhook server
// (src/server.ts) exposes over HTTP -- the same run-cache/eviction shape
// `kampong dev`'s and `kampong serve`'s servers use in the originating repo.
// Runs are process-local and in-memory -- there's no run-history store here
// -- so a process restart drops any run still in flight.

// A server process can run for a long time; without eviction, `runs` would
// grow by one entry per webhook event for the life of the process. Terminal
// runs (nothing left to poll or approve) are dropped a short while after they
// finish -- long enough for a slow client to still read the final state,
// short enough that this stays a bounded cache rather than a run-history
// store.
const DEFAULT_EVICT_AFTER_MS = 10 * 60 * 1000;

const TERMINAL_EVENT_TYPES: ReadonlySet<RunEvent["type"]> = new Set([
  "completed",
  "rejected",
  "failed",
]);

export interface StartRunResult {
  id: string;
  /** The run's state at the moment it was registered -- always `{ status: "running", trace: [] }`. Callers drive all further state off the run's "event" stream (e.g. an SSE route), not this snapshot. */
  state: RunState;
}

export interface RunManagerOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: ToolFetchImpl;
  /** Runs `action: component` tools and the Slack/Gmail tools (KAN-1886); src/components.generated.ts builds it. */
  components?: ComponentDispatcher;
  /** Test-only seam: overrides real BYOK/Mastra model resolution with a fake ModelClient. */
  createModel?: (spec: AgentSpec) => ModelClient;
  /** Test-only seam: how long a terminal run stays in `runs` before eviction (default 10 minutes). */
  evictAfterMs?: number;
  /**
   * KAN-1432 (ADR-0021 Slice D): when true, a run that pauses for approval
   * with a `spec.agent.approval_notifier` configured posts an interactive
   * Approve/Reject Slack message instead of relying on someone watching a
   * UI. src/server.ts (the webhook listener) always enables this -- there
   * is no canvas here to watch a pause happen.
   */
  notifyApprovalsViaSlack?: boolean;
  /** Test-only seam: overrides the fetch used for the outbound Slack API calls above (distinct from `fetchImpl`, which is for tool calls). Defaults to the real `fetch`. */
  slackFetchImpl?: typeof fetch;
  /**
   * KAN-1854 (ADR-0042): a run that pauses for approval writes a record to `.kampong/state.db`, so it can be
   * resolved by its key after a restart. Needs `spec` to resume a record no run in this process owns. In a
   * container, mount `/app/.kampong` as a volume, or the record dies with the container.
   */
  persistApprovals?: boolean;
  /** The spec that records are resumed under when no in-memory run owns the key. */
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

export class RunManager {
  private readonly runs = new Map<string, AgentRun>();
  private readonly evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly evictAfterMs: number;

  constructor(private readonly options: RunManagerOptions = {}) {
    this.evictAfterMs = options.evictAfterMs ?? DEFAULT_EVICT_AFTER_MS;
  }

  // Registers the run and kicks off run.start() without awaiting it, then
  // returns immediately with the id and the run's untouched initial state
  // ("running", empty trace). Every event from that point on -- including
  // the first step_started -- is driven purely by the AgentRun's "event"
  // emitter, which src/server.ts's SSE route (and this class's own eviction
  // hook, below) subscribe to.
  async start(
    spec: AgentSpec,
    input: string,
    trigger?: { headers?: Record<string, string> },
  ): Promise<StartRunResult> {
    const run = this.createRun(spec, trigger);
    const id = this.register(spec, run);
    // Fire-and-forget: the workflow engine already catches every real
    // failure mode itself and yields a "failed" RunEvent instead of
    // throwing, so a rejection here means something broke unexpectedly
    // upstream of that. Logging (rather than silently swallowing it) keeps
    // that visible without turning it into an unhandled rejection that
    // could crash the server process.
    run.start(input).catch((err: unknown) => {
      console.error(`Run ${id} failed unexpectedly:`, err);
    });
    return { id, state: run.getState() };
  }

  private createRun(spec: AgentSpec, trigger?: { headers?: Record<string, string> }): AgentRun {
    return createAgentRun(spec, {
      env: this.options.env,
      fetchImpl: this.options.fetchImpl,
      components: this.options.components,
      model: this.options.createModel?.(spec),
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
   * Resolves a pending approval by run id or by its persisted correlation key (KAN-1854, ADR-0042). A run
   * this process owns resumes in place; otherwise, with persistence on, the key is loaded from the store and
   * the run continues in a new run registered under a fresh id, which is how an approval survives a restart.
   * An unknown key resolves to a failed state with `errorCode: "approval_not_found"`.
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

  /** The approvals waiting in the store, oldest first. Empty when persistence is off or the store file does not exist yet. */
  async listPendingApprovals(): Promise<PersistedApproval[]> {
    if (!this.options.persistApprovals) return [];
    if (this.options.state) return listPendingApprovals(this.options.state);
    const path = this.options.statePath ?? ".kampong/state.db";
    if (!existsSync(path)) return [];
    const { SqliteStateStore } = await import("./sqlite-state-store.js");
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
    // Never keep the server process alive just for eviction bookkeeping.
    timer.unref?.();
    this.evictionTimers.set(id, timer);
  }
}
