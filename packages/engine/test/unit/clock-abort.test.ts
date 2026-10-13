import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realClock } from "../../src/pacing.js";
import { runUnattended } from "../../src/runner.js";
import { SqliteStateStore } from "../../src/sqlite-state-store.js";

// An aborted wait must clear its timer. The runner stopped waiting on abort but left a real setTimeout
// pending for the rest of the interval, so a stopped `kampong serve` (or an exported server) lingered, with
// nothing to do, until the next tick was due: up to the whole schedule interval.

describe("an aborted sleep clears its timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("realClock.sleep resolves at once on abort and leaves no timer behind", async () => {
    const controller = new AbortController();
    const slept = realClock.sleep(5 * 60_000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await slept;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns at once when the signal is already aborted, and still sleeps the full time without one", async () => {
    const controller = new AbortController();
    controller.abort();
    await realClock.sleep(5 * 60_000, controller.signal);
    expect(vi.getTimerCount()).toBe(0);

    let done = false;
    void realClock.sleep(1000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("a stopped runner leaves no pending timer, however long its interval", async () => {
    const store = new SqliteStateStore({ path: ":memory:" });
    const controller = new AbortController();
    const finished = runUnattended({
      name: "tick",
      job: async () => {},
      intervalMs: 5 * 60_000,
      jitterRatio: 0,
      store,
      signal: controller.signal,
    });
    // The first run happens, then the runner waits out the interval.
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    controller.abort();
    const result = await finished;
    expect(result.reason).toBe("aborted");
    expect(vi.getTimerCount()).toBe(0);
    await store.close();
  });
});
