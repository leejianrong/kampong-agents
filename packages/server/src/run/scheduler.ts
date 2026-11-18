import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  buildSchedule,
  createSchedulePacer,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  nextTick,
  runUnattended,
  type Clock,
  type RunnerEvent,
} from "@kampong/engine";
import { parseSpec, type AgentSpec } from "@kampong/spec";
import type { DbClient } from "../db/client.js";
import { specs } from "../db/schema.js";
import { withWorkspaceScope } from "../db/workspace-scope.js";
import { PgStateStore } from "./pg-state-store.js";
import type { HostedRunManager } from "./manager.js";

// KAM-203 (ADR-0056): runs a deployed spec's `schedule` trigger on the hosted server. One engine runner
// (`runUnattended`, the same one `kampong serve` uses) per live deployment: its overlap lock lives in the
// workspace's Postgres state store, so two server replicas never fire the same tick twice, and `skip`/`queue`
// overlap, jitter, backoff and fail-visible behave exactly as they do locally. Every read and write goes
// through `withWorkspaceScope`; the one cross-tenant read is the `list_live_deployments()` SQL function
// (drizzle/0015), which returns ids only.
//
// A deployment is registered when it goes live (deploy, un-pause) and dropped when it is paused or deleted. A
// run starts through `HostedRunManager.start`, so it reads the spec's current text, the workspace's model key
// and the same limits as any other hosted run. Changing the cadence of a deployed schedule needs a redeploy.

const MIN_LOCK_TTL_MS = 15 * 60_000;
const LOCK_INTERVALS = 5;
const SETTLE_POLL_MS = 60 * 60_000;

export interface HostedSchedulerOptions {
  log?: (line: string) => void;
  maxConsecutiveFailures?: number;
  now?: () => number;
  /** Test seams, passed to the runner. */
  clock?: Clock;
  random?: () => number;
}

interface Job {
  controller: AbortController;
  done: Promise<void>;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class HostedScheduler {
  private readonly jobs = new Map<string, Job>();
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private stopped = false;

  constructor(
    private readonly db: DbClient,
    private readonly manager: HostedRunManager,
    private readonly options: HostedSchedulerOptions = {},
  ) {
    this.log = options.log ?? ((line) => console.log(line));
    this.now = options.now ?? Date.now;
  }

  /** Registers every live deployment whose spec has a `schedule` trigger. Call once at boot. */
  async start(): Promise<void> {
    const result = await this.db.execute(
      sql`select workspace_id, deployment_id, spec_id from list_live_deployments()`,
    );
    for (const row of result.rows as Array<{
      workspace_id: string;
      deployment_id: string;
      spec_id: string;
    }>) {
      await this.register(row.workspace_id, row.deployment_id, row.spec_id).catch((err: unknown) =>
        this.log(
          `kampong server: could not schedule deployment ${row.deployment_id}: ${describeError(err)}`,
        ),
      );
    }
  }

  /** The deployment's job names, for tests and status. */
  get registered(): string[] {
    return [...this.jobs.keys()];
  }

  /** (Re)starts the deployment's job if its spec has a `schedule` trigger, and drops any job it had before. */
  async register(workspaceId: string, deploymentId: string, specId: string): Promise<void> {
    await this.unregister(deploymentId);
    if (this.stopped) return;
    const spec = await this.loadSpec(workspaceId, specId);
    const trigger = spec?.agent.trigger;
    if (trigger?.type !== "schedule") return;
    const built = buildSchedule(trigger);
    if (!built.ok) throw new Error(`schedule trigger: ${built.error}`);
    const schedule = built.value;

    const startedAt = this.now();
    const pacer = createSchedulePacer(schedule, trigger.overlap ?? "skip", startedAt);
    const firstTick = nextTick(schedule, startedAt, startedAt);
    const nominalMs = Math.max(nextTick(schedule, firstTick, startedAt) - firstTick, 60_000);
    const controller = new AbortController();
    const name = `deployment:${deploymentId}:schedule`;
    const maxFailures = this.options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;

    const onEvent = (e: RunnerEvent): void => {
      if (e.type === "failure") {
        this.log(
          `kampong server: scheduled run of deployment ${deploymentId} failed (${e.consecutiveFailures}/${maxFailures}): ${describeError(e.error)}` +
            (e.retryInMs === undefined ? "" : `; retrying in ${e.retryInMs}ms`),
        );
      } else if (e.type === "failure_limit") {
        this.log(
          `kampong server: deployment ${deploymentId} schedule stopped after ${e.consecutiveFailures} consecutive failures; last error: ${describeError(e.error)}. Redeploy to start it again.`,
        );
      }
    };

    const done = runUnattended({
      name,
      intervalMs: nominalMs,
      lockTtlMs: Math.max(nominalMs * LOCK_INTERVALS, MIN_LOCK_TTL_MS),
      nextDelayMs: (t, first) => pacer.nextDelayMs(t, first),
      store: new PgStateStore(this.db, workspaceId),
      signal: controller.signal,
      maxConsecutiveFailures: maxFailures,
      onEvent,
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      ...(this.options.random ? { random: this.options.random } : {}),
      job: async (signal) => {
        const { id, state } = await this.manager.start(workspaceId, specId, "");
        let final = state;
        // Hold the overlap lock until the run stops running; a run paused for approval is handed to the
        // approval routes, so the tick is done with it.
        while (final.status === "running" && !signal.aborted) {
          const next = await Promise.race([
            this.manager.settle(workspaceId, id, SETTLE_POLL_MS),
            new Promise<undefined>((resolve) =>
              signal.addEventListener("abort", () => resolve(undefined), { once: true }),
            ),
          ]);
          if (!next) break;
          final = next;
        }
        if (final.status === "failed") throw new Error(final.error ?? `run ${id} failed`);
      },
    })
      .then(() => undefined)
      .finally(() => {
        // Only forget this job: a redeploy may already have replaced it.
        if (this.jobs.get(deploymentId)?.controller === controller) this.jobs.delete(deploymentId);
      });
    this.jobs.set(deploymentId, { controller, done });
  }

  /** Stops the deployment's job (paused, deleted or about to be replaced) and waits for its tick to end. */
  async unregister(deploymentId: string): Promise<void> {
    const job = this.jobs.get(deploymentId);
    if (!job) return;
    this.jobs.delete(deploymentId);
    job.controller.abort();
    await job.done;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.jobs.keys()].map((id) => this.unregister(id)));
  }

  private async loadSpec(workspaceId: string, specId: string): Promise<AgentSpec | undefined> {
    const source = await withWorkspaceScope(this.db, workspaceId, async (tx) => {
      const [row] = await tx
        .select({ yamlSource: specs.yamlSource })
        .from(specs)
        .where(and(eq(specs.id, specId), eq(specs.workspaceId, workspaceId)));
      return row?.yamlSource;
    });
    if (source === undefined) return undefined;
    const parsed = parseSpec(source);
    return parsed.success && parsed.spec ? (parsed.spec as AgentSpec) : undefined;
  }
}
