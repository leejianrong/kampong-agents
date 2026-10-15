import { randomUUID } from "node:crypto";
import {
  buildSchedule,
  createSchedulePacer,
  parseEvery,
  processPoll,
  type ComponentDispatcher,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  nextTick,
  runnerLockKey,
  DEFAULT_STATE_DB_PATH,
  SqliteStateStore,
  runUnattended,
  type RunnerEvent,
  type RunState,
  type StateStore,
} from "@kampong/engine";
import type { AgentSpec } from "@kampong/spec";
import type { StartRunResult } from "./run-manager.js";

// KAN-1855: the `kampong serve` hook for the unattended runner (@kampong/engine's runUnattended).
// `kampong serve` collects the recurring jobs a spec declares and runs each under the runner (overlap
// lock in the StateStore, jitter, backoff, fail-visible). A `schedule` trigger (KAN-1856) yields one job
// whose cadence is the schedule's; the poll trigger (KAN-1857) will add its own. A spec with no recurring
// trigger yields no jobs and startServeRunners is a no-op: no state database is opened or created.

export interface ServeJob {
  /** Unique per served spec; keys the overlap lock. */
  name: string;
  /** Nominal gap between runs; sizes the lock TTL when `lockTtlMs` is not given. */
  intervalMs: number;
  /** Replaces the fixed `intervalMs` cadence; see RunnerOptions.nextDelayMs. */
  nextDelayMs?: (now: number, first: boolean) => number;
  lockTtlMs?: number;
  run(signal: AbortSignal, context: { store: StateStore }): Promise<void>;
  /**
   * Starts one run now and returns as soon as it has an id; `finished` settles when the run does. The
   * scheduled `run` is this plus waiting. Present on jobs that `POST /schedule/run-now` can trigger.
   */
  start?(signal: AbortSignal): Promise<{ id: string; state: RunState; finished: Promise<void> }>;
}

/** The slice of RunManager a scheduled job needs. */
export interface ScheduledRuns {
  start(
    spec: AgentSpec,
    input: string,
    trigger?: { headers?: Record<string, string>; fields?: Record<string, unknown> },
  ): Promise<StartRunResult>;
  settle(id: string, timeoutMs: number): Promise<RunState | undefined>;
}

/** What a poll job needs besides the run manager: a way to call the trigger's connector op. */
export interface PollDeps {
  components: ComponentDispatcher;
  env?: NodeJS.ProcessEnv;
}

export const SCHEDULE_JOB_NAME = "schedule";
export const POLL_JOB_NAME = "poll";
const MIN_LOCK_TTL_MS = 15 * 60_000;
// How long a scheduled run may keep its tick's lock: several nominal intervals, but at least 15 minutes.
// The runner does not renew a lock, so a run longer than this could overlap a second process's tick.
const LOCK_INTERVALS = 5;
const SETTLE_POLL_MS = 60 * 60_000;

/** The recurring jobs a spec's triggers define. */
export function collectServeJobs(
  spec: AgentSpec,
  runs?: ScheduledRuns,
  now: () => number = Date.now,
  poll?: PollDeps,
): ServeJob[] {
  const trigger = spec.agent.trigger;
  if (trigger?.type === "poll") return runs && poll ? [pollJob(spec, trigger, runs, poll)] : [];
  if (trigger?.type !== "schedule" || !runs) return [];
  const built = buildSchedule(trigger);
  if (!built.ok) throw new Error(`schedule trigger: ${built.error}`);
  const schedule = built.value;
  const startedAt = now();
  const pacer = createSchedulePacer(schedule, trigger.overlap ?? "skip", startedAt);
  const firstTick = nextTick(schedule, startedAt, startedAt);
  const nominalMs = Math.max(nextTick(schedule, firstTick, startedAt) - firstTick, 60_000);

  const start: NonNullable<ServeJob["start"]> = async (signal) => {
    const { id, state } = await runs.start(spec, "");
    const finished = (async () => {
      let final: RunState | undefined = state;
      // settle() returns when the run stops running or is paused for approval; a headless run that
      // pauses is handed to the approval routes, so the tick is done with it.
      while (final?.status === "running" && !signal.aborted) {
        final = await Promise.race([
          runs.settle(id, SETTLE_POLL_MS),
          new Promise<undefined>((resolve) =>
            signal.addEventListener("abort", () => resolve(undefined), { once: true }),
          ),
        ]);
      }
      if (final?.status === "failed") throw new Error(final.error ?? `run ${id} failed`);
    })();
    // A rejection must not go unhandled if the caller only wanted the id.
    finished.catch(() => {});
    return { id, state, finished };
  };

  return [
    {
      name: SCHEDULE_JOB_NAME,
      intervalMs: nominalMs,
      lockTtlMs: Math.max(nominalMs * LOCK_INTERVALS, MIN_LOCK_TTL_MS),
      nextDelayMs: (t, first) => pacer.nextDelayMs(t, first),
      run: async (signal) => {
        const started = await start(signal);
        await started.finished;
      },
      start,
    },
  ];
}

// KAM-117 (ADR-0050): one poll = call the trigger's op, keep the new items, start a run per item. Only the
// poll holds the overlap lock; the runs it starts go on without it, so a slow run never delays the next poll.
function pollJob(
  spec: AgentSpec,
  trigger: Extract<NonNullable<AgentSpec["agent"]["trigger"]>, { type: "poll" }>,
  runs: ScheduledRuns,
  { components, env }: PollDeps,
): ServeJob {
  const every = parseEvery(trigger.every);
  if (!every.ok) throw new Error(`poll trigger: ${every.error}`);
  const window = trigger.window === undefined ? undefined : parseEvery(trigger.window);
  if (window && !window.ok) throw new Error(`poll trigger: ${window.error}`);
  const tool = {
    name: POLL_JOB_NAME,
    action: "component" as const,
    use: trigger.use,
    op: trigger.op,
    ...(trigger.with && { with: trigger.with }),
    ...(trigger.config && { config: trigger.config }),
    ...(trigger.secrets && { secrets: trigger.secrets }),
  };
  return {
    name: POLL_JOB_NAME,
    intervalMs: every.value,
    run: async (signal, { store }) => {
      const call = await components.prepare(tool);
      const result = await call.run(trigger.with ?? {}, { ...(env && { env }) });
      await processPoll({
        store,
        result,
        config: {
          name: POLL_JOB_NAME,
          dedupe: trigger.dedupe,
          id: trigger.id,
          ...(trigger.items !== undefined && { items: trigger.items }),
          ...(window?.ok && { windowMs: window.value }),
          ...(trigger.one_run_per_item !== undefined && {
            oneRunPerItem: trigger.one_run_per_item,
          }),
        },
        start: async (batch) => {
          if (signal.aborted) throw new Error("poll: stopped before the run could start");
          const first = batch[0];
          const single = trigger.one_run_per_item !== false;
          const fields = single
            ? first !== null && typeof first === "object" && !Array.isArray(first)
              ? (first as Record<string, unknown>)
              : undefined
            : { items: batch };
          await runs.start(spec, JSON.stringify(single ? first : batch), {
            headers: {},
            ...(fields && { fields }),
          });
        },
      });
    },
  };
}

export interface ServeRunnerOptions {
  /** Opened lazily, only when there is at least one job. Defaults to the SQLite store under .kampong/. */
  openStore?: () => StateStore;
  log: (line: string) => void;
  maxConsecutiveFailures?: number;
  clock?: { now(): number; sleep(ms: number): Promise<void> };
  random?: () => number;
}

export type RunNowResult =
  | { status: "started"; id: string; state: RunState }
  /** The scheduled run (or another run-now) holds the overlap lock. */
  | { status: "busy" }
  | { status: "unknown_job" };

export interface ServeRunnersHandle {
  /** Starts job `name` immediately, taking the same overlap lock a scheduled tick takes. */
  runNow(name: string): Promise<RunNowResult>;
  /** Resolves once every runner has stopped: `failed` if any gave up after repeated failures. */
  done: Promise<{ failed: boolean }>;
  /** Aborts every runner and waits for in-flight jobs to finish. */
  stop(): Promise<void>;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function startServeRunners(
  jobs: ServeJob[],
  options: ServeRunnerOptions,
): ServeRunnersHandle {
  if (jobs.length === 0) {
    return {
      done: Promise.resolve({ failed: false }),
      stop: async () => {},
      runNow: async () => ({ status: "unknown_job" }),
    };
  }
  const store = (
    options.openStore ?? (() => new SqliteStateStore({ path: DEFAULT_STATE_DB_PATH }))
  )();
  const controller = new AbortController();
  const maxFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;

  const onEvent = (e: RunnerEvent): void => {
    if (e.type === "failure") {
      options.log(
        `kampong serve: job "${e.name}" failed (${e.consecutiveFailures}/${maxFailures}): ${describeError(e.error)}` +
          (e.retryInMs === undefined ? "" : `; retrying in ${e.retryInMs}ms`),
      );
    } else if (e.type === "failure_limit") {
      options.log(
        `kampong serve: job "${e.name}" stopped after ${e.consecutiveFailures} consecutive failures; last error: ${describeError(e.error)}`,
      );
    }
  };

  const running = jobs.map((job) =>
    runUnattended({
      name: job.name,
      job: (signal) => job.run(signal, { store }),
      intervalMs: job.intervalMs,
      ...(job.nextDelayMs ? { nextDelayMs: job.nextDelayMs } : {}),
      ...(job.lockTtlMs ? { lockTtlMs: job.lockTtlMs } : {}),
      store,
      signal: controller.signal,
      maxConsecutiveFailures: maxFailures,
      onEvent,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.random ? { random: options.random } : {}),
    }).then((result) => {
      // One job giving up is fatal for the service: stop its siblings so the process can exit non-zero.
      if (result.reason === "failure_limit") controller.abort();
      return result;
    }),
  );

  const done = Promise.all(running)
    .then((results) => ({ failed: results.some((r) => r.reason === "failure_limit") }))
    .finally(() => store.close());
  const runNow = async (name: string): Promise<RunNowResult> => {
    const job = jobs.find((j) => j.name === name);
    if (!job?.start) return { status: "unknown_job" };
    const holder = randomUUID();
    const key = runnerLockKey(job.name);
    const ttlMs = job.lockTtlMs ?? Math.max(job.intervalMs * 5, 60_000);
    if (!(await store.putIfAbsent(key, { holder }, { ttlMs }))) return { status: "busy" };
    const release = async (): Promise<void> => {
      const current = await store.get<{ holder?: string }>(key);
      if (current?.holder === holder) await store.delete(key);
    };
    try {
      const { id, state, finished } = await job.start(controller.signal);
      // The lock stays held until the run ends, so a tick that comes due meanwhile is an overlap.
      finished
        .catch((error: unknown) =>
          options.log(`kampong serve: run-now of "${job.name}" failed: ${describeError(error)}`),
        )
        .finally(() => release().catch(() => {}));
      return { status: "started", id, state };
    } catch (error) {
      await release().catch(() => {});
      throw error;
    }
  };

  return {
    done,
    runNow,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}
