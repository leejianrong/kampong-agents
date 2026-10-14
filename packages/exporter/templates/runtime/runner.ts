// Vendored from packages/engine/src/runner.ts as part of a `kampong export`
// -- see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. It is
// copied unchanged. From here on this file is yours: it will not be touched
// again by a future export.
//
// Unattended runner (ADR-0028, KAN-1855): a generic long-running loop that runs one job on an interval
// with an overlap lock, jitter, exponential backoff, graceful shutdown and fail-visible behaviour.
// It knows nothing about schedules or pollers (KAN-1856/1857 supply the jobs); time, sleep and
// randomness are injected so tests never really wait.
//
// Overlap lock: before each run the runner takes `runner:lock:<name>` with putIfAbsent and a TTL. A
// second process (or a restarted one whose predecessor crashed) skips its tick while the lock is live;
// a crashed holder's lock simply expires. lockTtlMs must exceed the longest expected run -- the lock
// is not renewed, and release only deletes a lock this runner still owns.
//
// Failure policy: a failed run is reported, then retried after an exponential backoff. After
// `maxConsecutiveFailures` in a row the runner emits `failure_limit` and returns reason "failure_limit"
// so the caller can exit non-zero. It never keeps failing silently.
// Unattended runner (ADR-0028, KAN-1855): a generic long-running loop that runs one job on an interval
// with an overlap lock, jitter, exponential backoff, graceful shutdown and fail-visible behaviour.
// It knows nothing about schedules or pollers (KAN-1856/1857 supply the jobs); time, sleep and
// randomness are injected so tests never really wait.
//
// Overlap lock: before each run the runner takes `runner:lock:<name>` with putIfAbsent and a TTL. A
// second process (or a restarted one whose predecessor crashed) skips its tick while the lock is live;
// a crashed holder's lock simply expires. lockTtlMs must exceed the longest expected run -- the lock
// is not renewed, and release only deletes a lock this runner still owns.
//
// Failure policy: a failed run is reported, then retried after an exponential backoff. After
// `maxConsecutiveFailures` in a row the runner emits `failure_limit` and returns reason "failure_limit"
// so the caller can exit non-zero. It never keeps failing silently.

import { randomUUID } from "node:crypto";
import { realClock, type Clock } from "./pacing.js";
import type { StateStore } from "./state-store.js";

export type RunnerEvent =
  | { type: "started"; name: string }
  | { type: "run_started"; name: string; run: number }
  | { type: "run_succeeded"; name: string; run: number; durationMs: number }
  | { type: "skipped"; name: string; reason: "locked" }
  | {
      type: "failure";
      name: string;
      run: number;
      consecutiveFailures: number;
      error: unknown;
      retryInMs: number | undefined;
    }
  | { type: "failure_limit"; name: string; consecutiveFailures: number; error: unknown }
  | { type: "stopped"; name: string; reason: RunnerStopReason };

export type RunnerStopReason = "aborted" | "failure_limit";

export interface BackoffOptions {
  baseMs?: number;
  factor?: number;
  maxMs?: number;
}

export interface RunnerOptions {
  /** Names the lock key and tags events. */
  name: string;
  /** The unit of work. Receives the runner's abort signal so it can cut short on shutdown. */
  job: (signal: AbortSignal) => Promise<void>;
  intervalMs: number;
  /**
   * Overrides the fixed `intervalMs` cadence (KAN-1856: a cron schedule has no fixed interval). Called with
   * the current time once before the first run (`first: true`, the runner then waits that long before
   * running) and again after every iteration, whether it ran, was skipped or failed. Returns the ms until
   * the next iteration; no jitter is applied, and a failed run still waits its backoff instead.
   */
  nextDelayMs?: (now: number, first: boolean) => number;
  store: StateStore;
  /** Lock TTL; defaults to max(intervalMs * 5, 60s). Must exceed the longest run. */
  lockTtlMs?: number;
  /** Fraction (0..1) of each wait randomised either side of the nominal delay. Default 0.1. */
  jitterRatio?: number;
  backoff?: BackoffOptions;
  /** Consecutive failed runs before the runner gives up visibly. Default 5. */
  maxConsecutiveFailures?: number;
  signal?: AbortSignal;
  onEvent?: (event: RunnerEvent) => void;
  clock?: Clock;
  /** Returns [0,1). Defaults to Math.random. */
  random?: () => number;
}

export interface RunnerResult {
  reason: RunnerStopReason;
  /** Runs started (including failed ones); skipped ticks are counted separately. */
  runs: number;
  skipped: number;
  consecutiveFailures: number;
  lastError?: unknown;
}

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_JITTER_RATIO = 0.1;
const DEFAULT_BACKOFF = { baseMs: 1000, factor: 2, maxMs: 5 * 60_000 };

export const runnerLockKey = (name: string): string => `runner:lock:${name}`;

export async function runUnattended(options: RunnerOptions): Promise<RunnerResult> {
  const {
    name,
    job,
    intervalMs,
    store,
    clock = realClock,
    random = Math.random,
    onEvent = () => {},
  } = options;
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const maxFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
  const lockTtlMs = options.lockTtlMs ?? Math.max(intervalMs * 5, 60_000);
  if (!(intervalMs > 0)) throw new Error("runUnattended: intervalMs must be a positive number.");
  if (!(jitterRatio >= 0 && jitterRatio <= 1)) {
    throw new Error("runUnattended: jitterRatio must be between 0 and 1.");
  }
  if (!Number.isInteger(maxFailures) || maxFailures < 1) {
    throw new Error("runUnattended: maxConsecutiveFailures must be a positive integer.");
  }
  if (!(lockTtlMs > 0)) throw new Error("runUnattended: lockTtlMs must be a positive number.");

  const signal = options.signal ?? new AbortController().signal;
  const holder = randomUUID();
  const lockKey = runnerLockKey(name);
  const result: RunnerResult = { reason: "aborted", runs: 0, skipped: 0, consecutiveFailures: 0 };

  const jittered = (ms: number): number =>
    Math.max(0, Math.round(ms * (1 + jitterRatio * (2 * random() - 1))));

  /** Sleeps, returning early (without error) if the signal aborts. */
  const wait = async (ms: number): Promise<void> => {
    if (signal.aborted) return;
    let onAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      // The signal goes to the clock too, so an aborted wait clears its timer: a pending real timer would
      // keep the process alive for the rest of the interval after the service has stopped.
      await Promise.race([clock.sleep(ms, signal), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };

  const release = async (): Promise<void> => {
    const current = await store.get<{ holder?: string }>(lockKey);
    if (current?.holder === holder) await store.delete(lockKey);
  };

  onEvent({ type: "started", name });
  if (options.nextDelayMs) await wait(Math.max(0, options.nextDelayMs(clock.now(), true)));
  while (!signal.aborted) {
    let delayMs = jittered(intervalMs);
    let failed = false;
    const acquired = await store.putIfAbsent(lockKey, { holder }, { ttlMs: lockTtlMs });
    if (!acquired) {
      result.skipped++;
      onEvent({ type: "skipped", name, reason: "locked" });
    } else {
      const run = ++result.runs;
      const startedAt = clock.now();
      onEvent({ type: "run_started", name, run });
      try {
        await job(signal);
        result.consecutiveFailures = 0;
        onEvent({ type: "run_succeeded", name, run, durationMs: clock.now() - startedAt });
      } catch (error) {
        failed = true;
        result.consecutiveFailures++;
        result.lastError = error;
        const exhausted = result.consecutiveFailures >= maxFailures;
        delayMs = jittered(
          Math.min(
            backoff.maxMs,
            backoff.baseMs * backoff.factor ** (result.consecutiveFailures - 1),
          ),
        );
        onEvent({
          type: "failure",
          name,
          run,
          consecutiveFailures: result.consecutiveFailures,
          error,
          retryInMs: exhausted ? undefined : delayMs,
        });
        if (exhausted) {
          onEvent({
            type: "failure_limit",
            name,
            consecutiveFailures: result.consecutiveFailures,
            error,
          });
          result.reason = "failure_limit";
          onEvent({ type: "stopped", name, reason: "failure_limit" });
          return result;
        }
      } finally {
        await release().catch(() => {});
      }
    }
    if (options.nextDelayMs) {
      const scheduled = Math.max(0, options.nextDelayMs(clock.now(), false));
      if (!failed) delayMs = scheduled;
    }
    await wait(delayMs);
  }
  onEvent({ type: "stopped", name, reason: "aborted" });
  return result;
}
