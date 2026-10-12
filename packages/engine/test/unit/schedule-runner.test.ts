import { describe, expect, it } from "vitest";
import { runUnattended, type RunnerEvent } from "../../src/runner.js";
import { buildSchedule, type Schedule } from "../../src/schedule.js";
import { createSchedulePacer, type OverlapPolicy } from "../../src/schedule-runner.js";
import type { StateStore } from "../../src/state-store.js";
import { createFakeClock } from "./state-store-contract.js";

// KAN-1856: a schedule driven through the unattended runner on a fake clock. Sleeping advances time, and
// a job "takes time" by advancing the same clock, so overlap (a tick coming due mid-run) is exact.

const MIN = 60_000;

function memoryStore(now: () => number): StateStore {
  const m = new Map<string, { value: unknown; exp?: number }>();
  const live = (k: string) => {
    const e = m.get(k);
    return e && (e.exp === undefined || e.exp > now()) ? e : undefined;
  };
  return {
    get: async (k) => live(k)?.value as never,
    put: async (k, value, o) => void m.set(k, { value, exp: o?.ttlMs && now() + o.ttlMs }),
    exists: async (k) => live(k) !== undefined,
    delete: async (k) => m.delete(k),
    putIfAbsent: async (k, value, o) => {
      if (live(k)) return false;
      m.set(k, { value, exp: o?.ttlMs && now() + o.ttlMs });
      return true;
    },
    list: async () => [],
    close: async () => {},
  };
}

const schedule = (spec: Parameters<typeof buildSchedule>[0]): Schedule => {
  const r = buildSchedule(spec);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

/** Runs the schedule until `maxRuns` runs have started; returns each run's start time (epoch ms). */
async function drive(opts: {
  schedule: Schedule;
  overlap: OverlapPolicy;
  start: number;
  /** How long run n (0-based) takes. */
  durations: (n: number) => number;
  maxRuns: number;
  preLocked?: { ttlMs: number };
  lockTtlMs?: number;
}) {
  const time = createFakeClock(opts.start);
  const store = memoryStore(time);
  const ac = new AbortController();
  const starts: number[] = [];
  const events: RunnerEvent[] = [];
  const pacer = createSchedulePacer(opts.schedule, opts.overlap, opts.start);
  if (opts.preLocked) {
    await store.putIfAbsent("runner:lock:schedule", { holder: "other" }, opts.preLocked);
  }
  const result = await runUnattended({
    name: "schedule",
    intervalMs: MIN,
    nextDelayMs: (now, first) => pacer.nextDelayMs(now, first),
    lockTtlMs: opts.lockTtlMs ?? 24 * 60 * MIN,
    store,
    signal: ac.signal,
    clock: {
      now: () => time(),
      sleep: async (ms) => time.advance(ms),
    },
    onEvent: (e) => events.push(e),
    job: async () => {
      const n = starts.length;
      starts.push(time());
      time.advance(opts.durations(n));
      if (starts.length >= opts.maxRuns) ac.abort();
    },
  });
  return { starts, events, result, pacer };
}

const T0 = Date.parse("2025-01-01T00:00:00Z");
const minutes = (starts: number[]) => starts.map((s) => (s - T0) / MIN);

describe("schedule through the unattended runner", () => {
  it("waits for the first tick, then runs on every tick (every)", async () => {
    const { starts } = await drive({
      schedule: schedule({ every: "10m" }),
      overlap: "skip",
      start: T0,
      durations: () => MIN,
      maxRuns: 4,
    });
    expect(minutes(starts)).toEqual([10, 20, 30, 40]);
  });

  describe("overlap: a run outlasts several ticks", () => {
    // Run 0 takes 45 minutes (ticks at 20, 30, 40, 50 come due while it runs); later runs take 1.
    const durations = (n: number) => (n === 0 ? 45 * MIN : MIN);

    it("skip drops the late ticks and resumes on the next tick after the run", async () => {
      const { starts, pacer } = await drive({
        schedule: schedule({ every: "10m" }),
        overlap: "skip",
        start: T0,
        durations,
        maxRuns: 4,
      });
      // Run 0 spans 10..55. Ticks 20,30,40,50 were dropped; the next is 60.
      expect(minutes(starts)).toEqual([10, 60, 70, 80]);
      expect(pacer.dropped).toBe(4);
    });

    it("queue keeps exactly one late tick and runs it as soon as the run ends", async () => {
      const { starts, pacer } = await drive({
        schedule: schedule({ every: "10m" }),
        overlap: "queue",
        start: T0,
        durations,
        maxRuns: 5,
      });
      // The four late ticks collapse into one queued run at 55 (not four), then the cadence resumes at 60.
      expect(minutes(starts)).toEqual([10, 55, 60, 70, 80]);
      expect(pacer.dropped).toBe(0);
    });

    it("never starts two runs at once", async () => {
      const { events } = await drive({
        schedule: schedule({ every: "10m" }),
        overlap: "queue",
        start: T0,
        durations,
        maxRuns: 5,
      });
      let open = 0;
      for (const e of events) {
        if (e.type === "run_started") open++;
        if (e.type === "run_succeeded") open--;
        expect(open).toBeLessThanOrEqual(1);
      }
    });
  });

  it("a tick that comes due while another holder owns the lock is skipped, then runs once it expires", async () => {
    const { starts, events } = await drive({
      schedule: schedule({ every: "10m" }),
      overlap: "skip",
      start: T0,
      durations: () => MIN,
      maxRuns: 1,
      preLocked: { ttlMs: 15 * MIN },
    });
    // The lock is live at the 10 minute tick and expired by the 20 minute tick.
    expect(events.filter((e) => e.type === "skipped")).toHaveLength(1);
    expect(minutes(starts)).toEqual([20]);
  });

  it("runs a cron schedule at its wall-clock time across a spring-forward change (America/New_York)", async () => {
    const start = Date.parse("2025-03-08T12:00:00Z");
    const { starts } = await drive({
      schedule: schedule({ cron: "30 2 * * *", tz: "America/New_York" }),
      overlap: "skip",
      start,
      durations: () => MIN,
      maxRuns: 3,
    });
    expect(starts.map((s) => new Date(s).toISOString())).toEqual([
      "2025-03-09T07:00:00.000Z", // 02:30 does not exist: first instant after the gap
      "2025-03-10T06:30:00.000Z",
      "2025-03-11T06:30:00.000Z",
    ]);
  });

  it("runs a cron schedule once across a fall-back change", async () => {
    const start = Date.parse("2025-11-01T12:00:00Z");
    const { starts } = await drive({
      schedule: schedule({ cron: "30 1 * * *", tz: "America/New_York" }),
      overlap: "skip",
      start,
      durations: () => MIN,
      maxRuns: 3,
    });
    expect(starts.map((s) => new Date(s).toISOString())).toEqual([
      "2025-11-02T05:30:00.000Z", // first 01:30
      "2025-11-03T06:30:00.000Z", // the repeated 01:30 (06:30Z) does not fire again
      "2025-11-04T06:30:00.000Z",
    ]);
  });
});
