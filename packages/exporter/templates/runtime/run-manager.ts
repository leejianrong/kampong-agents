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
import { AgentRun, createAgentRun, type RunState } from "./run.js";
import { postApprovalRequest, SlackApiError } from "./slack-approval.js";
import { resolveEnvValue } from "./http-tool.js";
import type { ModelClient } from "./model.js";
import type { RunEvent } from "./workflow.js";
import type { ToolFetchImpl } from "./http-tool.js";
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
              { token, channel: notifier.channel, runId: id, text: event.reason },
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
    // Never keep the server process alive just for eviction bookkeeping.
    timer.unref?.();
    this.evictionTimers.set(id, timer);
  }
}
