import {
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_STATE_DB_PATH,
  SqliteStateStore,
  runUnattended,
  type RunnerEvent,
  type StateStore,
} from "@kampong/engine";
import type { AgentSpec } from "@kampong/spec";

// KAN-1855: the `kampong serve` hook for the unattended runner (@kampong/engine's runUnattended).
// `kampong serve` collects the recurring jobs a spec declares and runs each under the runner (overlap
// lock in the StateStore, jitter, backoff, fail-visible). No spec can declare a schedule or poll
// trigger yet -- those land in KAN-1856/1857 and will return their jobs from collectServeJobs -- so
// today the list is empty and startServeRunners is a no-op: no state database is opened or created.

export interface ServeJob {
  /** Unique per served spec; keys the overlap lock. */
  name: string;
  intervalMs: number;
  run(signal: AbortSignal): Promise<void>;
}

/** The recurring jobs a spec's triggers define. Empty until schedule/poll triggers exist. */
export function collectServeJobs(_spec: AgentSpec): ServeJob[] {
  return [];
}

export interface ServeRunnerOptions {
  /** Opened lazily, only when there is at least one job. Defaults to the SQLite store under .kampong/. */
  openStore?: () => StateStore;
  log: (line: string) => void;
  maxConsecutiveFailures?: number;
  clock?: { now(): number; sleep(ms: number): Promise<void> };
  random?: () => number;
}

export interface ServeRunnersHandle {
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
    return { done: Promise.resolve({ failed: false }), stop: async () => {} };
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
      job: job.run,
      intervalMs: job.intervalMs,
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
  return {
    done,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}
