import { and, count, eq, gte, sql } from "drizzle-orm";
import {
  createTraceRecorder,
  type Trace,
  type TraceRecorder,
  createAgentRun,
  createComponentDispatcher,
  createFirstPartyRegistry,
  InProcessModuleRunner,
  type AgentRun,
  type ComponentDispatcher,
  type ModelClient,
  type RunEvent,
  type RunState,
  type ToolFetchImpl,
  ToolCallError,
} from "@kampong/engine";
import { parseSpec, type AgentSpec } from "@kampong/spec";
import type { DbClient } from "../db/client.js";
import { withWorkspaceScope } from "../db/workspace-scope.js";
import { deployments, runs, specs } from "../db/schema.js";
import { resolveWorkspaceModelClient } from "../model/resolve.js";
import { resolveWorkspaceSecrets, secretNamesFor } from "../secrets/resolve.js";
import { PgStateStore } from "./pg-state-store.js";
import {
  DEFAULT_RUN_LIMITS,
  PAUSED_FOR_MONTHLY_LIMIT,
  RunLimitError,
  type RunLimits,
} from "./limits.js";
import { recordAudit } from "../audit/audit.js";
import { createGuardedFetch, EgressBlockedError, parseAllowHosts } from "./ssrf-guard.js";
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

/**
 * A 1.1 feature the hosted server cannot run yet (KAM-203). Refused up front, by name, so a run never starts
 * and then fails or silently does nothing partway: the `schedule`/`poll` triggers need a scheduler and a webhook's `respond: sync` needs the ingress to hold
 * the request (KAM-203).
 */
export class UnsupportedOnHostedError extends Error {
  constructor(feature: string) {
    super(
      `${feature} is not available on the hosted server yet. Run it locally with \`kampong run\`.`,
    );
    this.name = "UnsupportedOnHostedError";
  }
}

/** The first hosted-unsupported feature the spec uses, or undefined. `webhook` also checks the trigger a deployment would fire. */
export function hostedUnsupportedFeature(
  spec: AgentSpec,
  { webhook = false }: { webhook?: boolean } = {},
): string | undefined {
  const trigger = spec.agent.trigger;
  if (webhook) {
    // `schedule` runs on the hosted scheduler (KAM-203, src/run/scheduler.ts). `poll` stays refused until a
    // workspace can store the connector credentials its op needs (KAM-81).
    if (trigger?.type === "poll") return "The `poll` trigger";
    // `respond: sync` holds the caller until the run settles; the hosted ingress always answers with a run id.
    if (trigger?.type === "webhook" && trigger.respond === "sync") {
      return "The webhook `respond: sync` mode";
    }
  }
  return undefined;
}

export class InvalidStoredSpecError extends Error {
  constructor(specId: string) {
    super(`Stored spec "${specId}" could not be parsed into a runnable AgentSpec.`);
    this.name = "InvalidStoredSpecError";
  }
}

export interface HostedRunManagerOptions {
  /**
   * The environment a run's tools, components and `${ENV}` var defaults read. Defaults to EMPTY, never
   * the server's `process.env`: a tenant's spec must not be able to name the server's own secrets
   * (the database URL, the BYOK root key) in a tool header. A workspace's own tool secrets (KAM-81) are added
   * per run from its vault (`resolveWorkspaceSecrets`); one it has not stored makes the step that needs it fail
   * visibly. Model keys come from the BYOK vault (`resolveWorkspaceModelClient`).
   */
  env?: NodeJS.ProcessEnv;
  /** The environment used to build the model client (provider base URL, BYOK root key). Defaults to `process.env`. */
  modelEnv?: NodeJS.ProcessEnv;
  /** Test-only seam: replaces the first-party component dispatcher. */
  components?: ComponentDispatcher;
  /**
   * What sends a tool's or component's HTTP request. Defaults to a guarded fetch that refuses private, loopback,
   * link-local and metadata addresses (KAM-232). Replacing it is a test seam: a replacement is not guarded.
   */
  fetchImpl?: ToolFetchImpl;
  /**
   * Private hosts a tool may reach anyway: the self-host exception for internal services an operator chooses.
   * Exact hostnames or IP addresses. Defaults to `KAMPONG_EGRESS_ALLOW_HOSTS` (comma-separated), else none.
   */
  egressAllowHosts?: readonly string[];
  /**
   * Test-only seam (mirrors packages/cli's `RunManagerOptions.createModel`):
   * bypasses the real per-workspace BYOK/LiteLLM resolution
   * (`resolveWorkspaceModelClient`) with a fake `ModelClient`, so run-lifecycle
   * behavior is exercised deterministically with no network and no stored key.
   */
  createModel?: (spec: AgentSpec) => ModelClient | Promise<ModelClient>;
  /** Per-workspace run limits (KAM-323); fields left out use the defaults in limits.ts. 0 turns one off. */
  limits?: Partial<RunLimits>;
  /** Test-only seam: how long a terminal run stays in the live map before eviction (default 10 minutes). */
  evictAfterMs?: number;
}

export type RunSource = "webhook" | "schedule" | "manual";

/** What a caller may supply for one run, like `kampong run --var` and a webhook's headers and body. */
export interface StartRunOptions {
  /** Values for the spec's `vars` (version 1.1); the engine checks names and types and fails the run visibly. */
  vars?: Record<string, unknown>;
  /** True when a deployment's webhook starts the run, so the trigger is checked too. */
  viaWebhook?: boolean;
  /** How the run started, recorded on its row (KAM-324). Defaults to `webhook` for a webhook run and `manual` otherwise. */
  source?: RunSource;
  /** Who or what started it: a user id for a manual run, a fixed label for a webhook or a schedule. */
  triggeredBy?: string;
  trigger?: { headers?: Record<string, string>; body?: unknown; fields?: Record<string, unknown> };
}

/**
 * The only components a hosted run can use are the first-party `kampong/*` ones that ship with the server.
 * A workspace cannot add a module component: that would run tenant-supplied code in the server process.
 */
function firstPartyDispatcher(): ComponentDispatcher {
  const registry = createFirstPartyRegistry();
  return createComponentDispatcher({ registry, runner: new InProcessModuleRunner(registry) });
}

export interface StartRunResult {
  id: string;
  state: RunState;
}

/** A run that failed only because another caller had already resolved (or the record had expired for) its approval. */
function isLostApproval(state: RunState): boolean {
  return (
    state.status === "failed" &&
    (state.errorCode === "already_resolved" || state.errorCode === "approval_not_found")
  );
}

export class HostedRunManager {
  private readonly live = new Map<string, AgentRun>();
  // ADR-0063: a resident run's trace recorder; it goes with the run.
  private readonly recorders = new WeakMap<AgentRun, TraceRecorder>();
  private readonly evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Per-run serialized persist tail: run events fire faster than a DB write
  // completes, so chain each run's writes to guarantee the terminal state is
  // the last one persisted (a late earlier write could otherwise clobber it).
  private readonly persistTails = new Map<string, Promise<void>>();
  private readonly evictAfterMs: number;
  private readonly components = firstPartyDispatcher();
  private readonly toolFetch: ToolFetchImpl;
  // What the model client sends its requests with (KAM-337). A spec may name its own `agent.model.base_url`, so the
  // model path needs the same rule as a tool. The operator's own LiteLLM gateway is on the allow list: it is
  // internal by design and not tenant-controlled.
  private readonly modelFetch: typeof fetch;
  private readonly limits: RunLimits;
  // KAM-323: a run stopped for taking too long, by id, with the reason. Its row is already terminal, so later events
  // from the engine must not overwrite it.
  private readonly stopped = new Map<string, string>();
  private readonly runtimeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // What lets the manager end a run it cannot cancel: once `stopped` is set, the next model or tool call it makes fails.
  private readonly leases = new WeakMap<AgentRun, RunLease>();

  constructor(
    private readonly db: DbClient,
    private readonly options: HostedRunManagerOptions = {},
  ) {
    this.evictAfterMs = options.evictAfterMs ?? DEFAULT_EVICT_AFTER_MS;
    this.limits = { ...DEFAULT_RUN_LIMITS, ...options.limits };
    const allowHosts =
      options.egressAllowHosts ?? parseAllowHosts(process.env["KAMPONG_EGRESS_ALLOW_HOSTS"]);
    this.toolFetch = options.fetchImpl ?? createGuardedFetch({ allowHosts });
    const gateway = hostOf((options.modelEnv ?? process.env)["LITELLM_BASE_URL"]);
    const modelGuard = createGuardedFetch({
      allowHosts: gateway ? [...allowHosts, gateway] : allowHosts,
    });
    this.modelFetch =
      options.fetchImpl !== undefined
        ? (((input, init) =>
            options.fetchImpl!(input, init, { toolName: "model" })) as typeof fetch)
        : (((input, init) => modelGuard(input, init, { toolName: "model" })) as typeof fetch);
  }

  /**
   * Wraps a request sender so a refusal by the egress guard is written to the workspace's audit log (KAM-337) before
   * it goes on to fail the step. Only the origin is recorded, never a path or query.
   */
  private audited<F extends (...args: never[]) => Promise<Response>>(
    workspaceId: string,
    specId: string,
    via: "tool" | "model",
    send: F,
  ): F {
    const wrapped = (async (...args: Parameters<F>) => {
      try {
        return await send(...args);
      } catch (err) {
        if (err instanceof EgressBlockedError) {
          await recordAudit(this.db, {
            workspaceId,
            actor: "system",
            action: "egress.blocked",
            target: err.origin,
            outcome: "deny",
            detail: {
              via,
              ...(err.toolName && via === "tool" ? { tool: err.toolName } : {}),
              reason: err.reason,
              specId,
            },
          });
        }
        throw err;
      }
    }) as unknown as F;
    return Object.assign(wrapped, send);
  }

  /**
   * Builds an unstarted run of the workspace's spec: resolves the spec, the workspace's model client and the
   * secrets the spec reads. Shared by `start` and by an approval resumed on a replica that did not start the run.
   * Approvals are persisted (KAM-348) so any replica can resolve one.
   */
  private async buildRun(
    workspaceId: string,
    specId: string,
    runOptions: StartRunOptions,
  ): Promise<{ run: AgentRun; recorder: TraceRecorder }> {
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
    const unsupported = hostedUnsupportedFeature(spec, { webhook: runOptions.viaWebhook });
    if (unsupported) throw new UnsupportedOnHostedError(unsupported);

    const recorder = createTraceRecorder(spec);
    const model = this.options.createModel
      ? await this.options.createModel(spec)
      : await resolveWorkspaceModelClient({
          db: this.db,
          workspaceId,
          spec,
          env: this.options.modelEnv,
          onUsage: recorder.reportUsage,
          fetchImpl: this.audited(workspaceId, specId, "model", this.modelFetch),
        });

    // KAM-81: the `${NAME}`s the spec reads, resolved from this workspace's vault for this run only. Unset ones stay
    // absent, so the engine fails the step that needs one, naming it.
    const secrets = await resolveWorkspaceSecrets({
      db: this.db,
      workspaceId,
      names: await secretNamesFor(spec),
      env: this.options.modelEnv,
    });

    const lease: RunLease = {};
    const run = createAgentRun(spec, {
      persistApprovals: true,
      model: stoppable(lease, recorder.wrapModel(model)),
      env: { ...(this.options.env ?? {}), ...secrets },
      fetchImpl: stoppableFetch(lease, this.audited(workspaceId, specId, "tool", this.toolFetch)),
      components: this.options.components ?? this.components,
      // A `dedupe` step remembers its keys here (KAM-113): Postgres, scoped to this workspace under RLS. It is
      // only a handle (every call opens its own scoped transaction), so a workflow with no dedupe step never
      // touches the table.
      state: new PgStateStore(this.db, workspaceId),
      ...(runOptions.vars ? { vars: runOptions.vars } : {}),
      ...(runOptions.trigger ? { trigger: runOptions.trigger } : {}),
    });
    recorder.attach(run);
    this.recorders.set(run, recorder);
    this.leases.set(run, lease);
    return { run, recorder };
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
  async start(
    workspaceId: string,
    specId: string,
    input: string,
    runOptions: StartRunOptions = {},
  ): Promise<StartRunResult> {
    const { run } = await this.buildRun(workspaceId, specId, runOptions);
    const initialState = run.getState();

    let id: string;
    try {
      id = await this.insertRun(workspaceId, specId, input, runOptions, initialState);
    } catch (err) {
      if (err instanceof RunLimitError && err.code === "monthly")
        await this.pauseForMonthlyLimit(workspaceId);
      throw err;
    }

    this.live.set(id, run);
    this.watch(workspaceId, id, run);
    this.armRuntime(workspaceId, id, run);
    run.start(input).catch((err: unknown) => {
      console.error(`Hosted run ${id} failed unexpectedly:`, err);
    });

    return { id, state: initialState };
  }

  /**
   * Checks the workspace's limits and inserts the run row in one transaction. An advisory lock keyed on the
   * workspace makes the count and the insert atomic across replicas, so two starts cannot both take the last slot.
   */
  private async insertRun(
    workspaceId: string,
    specId: string,
    input: string,
    runOptions: StartRunOptions,
    initialState: RunState,
  ): Promise<string> {
    return withWorkspaceScope(this.db, workspaceId, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
      const { maxConcurrent, maxPerMonth, maxRuntimeMs } = this.limits;
      if (maxConcurrent > 0) {
        // A `running` row older than twice the time limit belongs to a run that died with its process; it must not
        // hold a slot for ever.
        const cutoff = new Date(
          Date.now() - (maxRuntimeMs > 0 ? maxRuntimeMs * 2 : 24 * 3_600_000),
        );
        const [row] = await tx
          .select({ n: count() })
          .from(runs)
          .where(
            and(
              eq(runs.workspaceId, workspaceId),
              eq(runs.status, "running"),
              gte(runs.startedAt, cutoff),
            ),
          );
        if ((row?.n ?? 0) >= maxConcurrent) throw new RunLimitError("concurrency", maxConcurrent);
      }
      if (maxPerMonth > 0) {
        const now = new Date();
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const [row] = await tx
          .select({ n: count() })
          .from(runs)
          .where(and(eq(runs.workspaceId, workspaceId), gte(runs.startedAt, monthStart)));
        if ((row?.n ?? 0) >= maxPerMonth) throw new RunLimitError("monthly", maxPerMonth);
      }
      const [row] = await tx
        .insert(runs)
        .values({
          workspaceId,
          specId,
          input,
          status: initialState.status,
          traceJson: initialState.trace,
          source: runOptions.source ?? (runOptions.viaWebhook ? "webhook" : "manual"),
          ...(runOptions.triggeredBy !== undefined && { triggeredBy: runOptions.triggeredBy }),
        })
        .returning({ id: runs.id });
      return row!.id;
    });
  }

  /** The workspace used its runs for the month: its live deployments pause, with the reason, and the event is audited. */
  private async pauseForMonthlyLimit(workspaceId: string): Promise<void> {
    try {
      const paused = await withWorkspaceScope(this.db, workspaceId, (tx) =>
        tx
          .update(deployments)
          .set({ status: "paused", pausedReason: PAUSED_FOR_MONTHLY_LIMIT, updatedAt: new Date() })
          .where(and(eq(deployments.workspaceId, workspaceId), eq(deployments.status, "live")))
          .returning({ id: deployments.id }),
      );
      if (paused.length > 0) {
        await recordAudit(this.db, {
          workspaceId,
          actor: "system",
          action: "deployment.paused_by_limit",
          outcome: "deny",
          detail: { reason: PAUSED_FOR_MONTHLY_LIMIT, deployments: paused.length },
        });
      }
    } catch (err) {
      console.error("Pausing deployments at the monthly run limit failed:", err);
    }
  }

  /**
   * Starts the run's clock while it is working and stops it while it waits for a person (a run paused for approval
   * may wait for days). Past the limit the run is stopped (KAM-323).
   */
  private armRuntime(workspaceId: string, id: string, run: AgentRun): void {
    if (this.limits.maxRuntimeMs <= 0 || this.runtimeTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.runtimeTimers.delete(id);
      void this.stopForTime(workspaceId, id, run);
    }, this.limits.maxRuntimeMs);
    timer.unref?.();
    this.runtimeTimers.set(id, timer);
  }

  private disarmRuntime(id: string): void {
    const timer = this.runtimeTimers.get(id);
    if (timer) clearTimeout(timer);
    this.runtimeTimers.delete(id);
  }

  /**
   * Ends a run that has run too long. The engine has no cancel, so the run's next model or tool call is made to
   * fail, and the row is written as failed now so nobody waits on a call that may never return.
   */
  private async stopForTime(workspaceId: string, id: string, run: AgentRun): Promise<void> {
    const state = run.getState();
    if (state.status !== "running") return;
    const minutes = Math.round(this.limits.maxRuntimeMs / 60_000);
    const message = `Stopped: this run took longer than ${minutes} minute${minutes === 1 ? "" : "s"}, the limit for a workspace.`;
    this.stopped.set(id, message);
    const lease = this.leases.get(run);
    if (lease) lease.stopped = message;
    this.live.delete(id);
    this.persistTails.set(
      id,
      (this.persistTails.get(id) ?? Promise.resolve())
        .then(() => this.persist(workspaceId, id, { ...state, status: "failed", error: message }))
        .catch((err: unknown) => console.error(`Persisting stopped run ${id} failed:`, err)),
    );
    await recordAudit(this.db, {
      workspaceId,
      actor: "system",
      action: "run.timeout",
      target: id,
      outcome: "deny",
      detail: { limitMs: this.limits.maxRuntimeMs },
    });
    this.scheduleEviction(id);
  }

  /**
   * Resolves with the run's state once it stops running (done, failed, rejected or paused for approval) or after
   * `timeoutMs`, whichever comes first. Never stops the run. A run no longer resident (evicted, or started by
   * another replica) answers from its persisted row.
   */
  async settle(workspaceId: string, id: string, timeoutMs: number): Promise<RunState | undefined> {
    const run = this.live.get(id);
    if (!run) return this.get(workspaceId, id);
    if (run.getState().status !== "running") return run.getState();
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        run.off("event", check);
        resolve(run.getState());
      };
      const check = (): void => {
        if (run.getState().status !== "running") finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      run.on("event", check);
    });
  }

  /**
   * The trace of a run that is still resident in this process, or `undefined` (unknown run, another
   * workspace's, or one already evicted: stored traces come with KAM-257). Ownership is confirmed first, as in
   * `get`.
   */
  async getTrace(workspaceId: string, id: string): Promise<Trace | undefined> {
    const owned = await this.resolveOwned(workspaceId, id);
    return owned?.run && this.recorders.get(owned.run)?.snapshot();
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
    const owned = await this.resolveOwned(workspaceId, id);
    if (!owned) return undefined;
    return owned.run ? owned.run.getState() : owned.persisted;
  }

  /**
   * For the SSE stream route (KAN-1425): confirms the run belongs to
   * `workspaceId` (scoped read, RLS-gated) and returns the live `AgentRun` to
   * subscribe to if it's still resident, plus the current state to send as the
   * stream's opening frame. `undefined` (→ 404) if the run isn't this
   * workspace's. `run` is `undefined` when the run exists but has already
   * finished and been evicted -- the caller sends `state` once and closes.
   */
  async resolveForStream(
    workspaceId: string,
    id: string,
  ): Promise<{ run: AgentRun | undefined; state: RunState } | undefined> {
    const owned = await this.resolveOwned(workspaceId, id);
    if (!owned) return undefined;
    return { run: owned.run, state: owned.run ? owned.run.getState() : owned.persisted };
  }

  /**
   * Resolves a run's pending approval (KAN-1425). Returns the resumed state,
   * `undefined` if no such run exists in this workspace (→ 404), and throws
   * (→ 409) if the run is no longer live or isn't actually awaiting approval.
   * Persistence of the resumed run happens through the same per-event handler
   * `start` registered.
   */
  async approve(
    workspaceId: string,
    id: string,
    approved: boolean,
    reason?: string,
  ): Promise<RunState | undefined> {
    const owned = await this.resolveOwned(workspaceId, id);
    if (!owned) return undefined;
    if (!owned.run) {
      if (owned.persisted.status !== "awaiting_approval" || !owned.pendingApprovalKey) {
        throw new Error(`Run "${id}" is not awaiting approval.`);
      }
      return this.resumeFromStore(workspaceId, id, owned, approved, reason);
    }
    // resume() itself throws if the run isn't awaiting approval -- surfaced as
    // a 409 by the route, same as the CLI's own approve path.
    const state = await owned.run.resume(approved, reason);
    if (isLostApproval(state)) {
      throw new Error(
        `Run "${id}" was already resolved by another caller, or its approval expired.`,
      );
    }
    return state;
  }

  /**
   * Resumes a paused run this replica does not hold (KAM-348): another replica started it, or it was evicted or
   * the process restarted. The engine claims the stored approval record, so of two callers only one resumes it;
   * the other gets a 409. The run continues here, under the same run id.
   */
  private async resumeFromStore(
    workspaceId: string,
    id: string,
    owned: { specId: string; pendingApprovalKey?: string },
    approved: boolean,
    reason: string | undefined,
  ): Promise<RunState> {
    const { run } = await this.buildRun(workspaceId, owned.specId, {});
    // Nothing is persisted until the claim has succeeded: a lost race reports failed, and must not overwrite
    // the row the winner is updating.
    const state = await run.resumeByKey(owned.pendingApprovalKey!, approved, reason);
    if (isLostApproval(state)) {
      throw new Error(
        `Run "${id}" was already resolved by another caller, or its approval expired.`,
      );
    }
    this.live.set(id, run);
    this.enqueuePersist(workspaceId, id, state);
    this.watch(workspaceId, id, run);
    if (TERMINAL_STATUSES.has(state.status)) this.scheduleEviction(id);
    return state;
  }

  /** Persists a live run's state after every event, and schedules its eviction once it ends. */
  private watch(workspaceId: string, id: string, run: AgentRun): void {
    run.on("event", (event: RunEvent) => {
      const state = run.getState();
      // This replica lost the race to resolve the run's approval: the winner owns the row.
      if (isLostApproval(state)) {
        this.live.delete(id);
        return;
      }
      if (this.stopped.has(id)) return;
      this.enqueuePersist(workspaceId, id, state);
      if (state.status === "running") this.armRuntime(workspaceId, id, run);
      else this.disarmRuntime(id);
      if (TERMINAL_EVENT_TYPES.has(event.type)) this.scheduleEviction(id);
    });
  }

  /**
   * Shared ownership gate: one scoped `runs` read (so RLS confirms the run is
   * this workspace's), plus the live `AgentRun` if resident and the persisted
   * state as a fallback. Every per-run accessor goes through this so the live
   * map (id-keyed, cross-workspace) is never consulted without first proving
   * ownership.
   */
  private async resolveOwned(
    workspaceId: string,
    id: string,
  ): Promise<
    | {
        run: AgentRun | undefined;
        persisted: RunState;
        specId: string;
        pendingApprovalKey?: string;
      }
    | undefined
  > {
    const [row] = await withWorkspaceScope(this.db, workspaceId, (tx) =>
      tx
        .select()
        .from(runs)
        .where(and(eq(runs.id, id), eq(runs.workspaceId, workspaceId))),
    );
    if (!row) return undefined;
    return {
      run: this.live.get(id),
      specId: row.specId,
      ...(row.pendingApprovalKey ? { pendingApprovalKey: row.pendingApprovalKey } : {}),
      persisted: {
        status: row.status as RunState["status"],
        trace: row.traceJson as RunState["trace"],
        finalOutput: (row.finalOutput as RunState["finalOutput"]) ?? undefined,
        error: row.error ?? undefined,
      },
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
          pendingApprovalKey: state.pendingApproval?.key ?? null,
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
      this.stopped.delete(id);
    }, this.evictAfterMs);
    timer.unref?.();
    this.evictionTimers.set(id, timer);
  }
}

/** Set once a run has been stopped for time; the run's model and tool calls then fail (KAM-323). */
interface RunLease {
  stopped?: string;
}

function stoppable(lease: RunLease, model: ModelClient): ModelClient {
  return {
    generateText: (input) =>
      lease.stopped ? Promise.reject(new Error(lease.stopped)) : model.generateText(input),
    generateStructured: (input) =>
      lease.stopped ? Promise.reject(new Error(lease.stopped)) : model.generateStructured(input),
  };
}

function stoppableFetch(lease: RunLease, send: ToolFetchImpl): ToolFetchImpl {
  const wrapped = ((input, init, context) =>
    lease.stopped
      ? Promise.reject(new ToolCallError(lease.stopped, "timeout", false))
      : send(input, init, context)) as ToolFetchImpl;
  return Object.assign(wrapped, send);
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}
