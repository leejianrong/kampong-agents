// Turns a schedule into the cadence the unattended runner follows (KAN-1856, ADR-0028). The runner runs
// one job at a time, so a tick that comes due while a run is still going is an overlap:
//  - `skip`: the late tick is dropped; the next run waits for the first tick after the run finished.
//  - `queue`: one late tick is kept and runs as soon as the current run ends, however many ticks passed
//    (the queue holds at most one run). Normal cadence resumes after it.
// A second process sharing the state store is held off by the runner's own lock (it skips its tick), so
// `skip` also covers two `kampong serve` instances pointed at the same store.

import { nextTick, type Schedule } from "./schedule.js";

export type OverlapPolicy = "skip" | "queue";

export interface SchedulePacer {
  /** The `nextDelayMs` hook for `runUnattended`. */
  nextDelayMs(now: number, first: boolean): number;
  /** Ticks dropped because a run was still going (always 0 for `queue`, which collapses them into one). */
  readonly dropped: number;
  /** The next tick, for status output. */
  readonly nextDue: number | undefined;
}

export function createSchedulePacer(
  schedule: Schedule,
  overlap: OverlapPolicy,
  startedAt: number,
): SchedulePacer {
  let due: number | undefined;
  let dropped = 0;
  const after = (t: number): number => nextTick(schedule, t, startedAt);
  return {
    get dropped() {
      return dropped;
    },
    get nextDue() {
      return due;
    },
    nextDelayMs(now, first) {
      if (first || due === undefined) {
        due = after(now);
        return due - now;
      }
      // The tick that just ran was `due`; the one after it decides what happens next.
      const upcoming = after(due);
      if (upcoming > now) {
        due = upcoming;
        return upcoming - now;
      }
      // At least one tick came due while the run was going.
      let latestLate = upcoming;
      let late = 1;
      for (let n = after(latestLate); n <= now; n = after(latestLate)) {
        latestLate = n;
        late++;
      }
      if (overlap === "queue") {
        due = latestLate; // one queued run covers them all
        return 0;
      }
      dropped += late;
      due = after(now);
      return due - now;
    },
  };
}
