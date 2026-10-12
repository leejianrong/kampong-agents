import { describe, expect, it } from "vitest";
import { runUnattended, type RunnerEvent, type RunnerOptions } from "../../src/runner.js";
import type { StateStore } from "../../src/state-store.js";
import { createFakeClock } from "./state-store-contract.js";

// KAN-1855: the unattended runner. Every timing path runs on a fake clock whose sleep advances time
// instead of waiting, with an injected random source -- nothing here really sleeps.

/** Minimal in-memory StateStore honouring TTL against the fake clock (the contract suite covers the real ones). */
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

function harness(over: Partial<RunnerOptions> & { job: RunnerOptions["job"] }) {
  const time = createFakeClock(0);
  const sleeps: number[] = [];
  const events: RunnerEvent[] = [];
  const ac = new AbortController();
  const store = memoryStore(time);
  const opts: RunnerOptions = {
    name: "poll",
    intervalMs: 1000,
    store,
    clock: {
      now: () => time(),
      sleep: async (ms) => {
        sleeps.push(ms);
        time.advance(ms);
      },
    },
    random: () => 0.5, // jitter factor 1.0 (no offset)
    jitterRatio: 0,
    signal: ac.signal,
    onEvent: (e) => events.push(e),
    ...over,
  };
  return { opts, sleeps, events, ac, store, time };
}

describe("runUnattended", () => {
  it("runs the job every interval until aborted, then stops gracefully", async () => {
    let n = 0;
    const h = harness({
      job: async () => {
        if (++n === 3) h.ac.abort();
      },
    });
    const result = await runUnattended(h.opts);
    expect(result.reason).toBe("aborted");
    expect(n).toBe(3);
    expect(result.runs).toBe(3);
    expect(h.sleeps.slice(0, 2)).toEqual([1000, 1000]);
    expect(h.events.at(-1)?.type).toBe("stopped");
  });

  it("does not start a job when already aborted", async () => {
    let n = 0;
    const h = harness({ job: async () => void n++ });
    h.ac.abort();
    expect((await runUnattended(h.opts)).reason).toBe("aborted");
    expect(n).toBe(0);
  });

  it("applies jitter within +/- jitterRatio of the interval", async () => {
    const randoms = [0, 1, 0.5];
    let calls = 0;
    let n = 0;
    const h = harness({
      jitterRatio: 0.2,
      random: () => randoms[Math.min(calls++, 2)]!,
      job: async () => {
        n++;
        if (n === 3) h.ac.abort();
      },
    });
    await runUnattended(h.opts);
    // random 0 -> 800, random 1 -> 1200
    expect(h.sleeps.slice(0, 2)).toEqual([800, 1200]);
  });

  it("skips a tick when another holder owns the lock, and recovers after the lock TTL", async () => {
    let ran = 0;
    const h = harness({
      lockTtlMs: 2500,
      job: async () => {
        ran++;
        h.ac.abort();
      },
    });
    await h.store.putIfAbsent("runner:lock:poll", { holder: "other" }, { ttlMs: 2500 });
    const result = await runUnattended(h.opts);
    const skipped = h.events.filter((e) => e.type === "skipped");
    expect(skipped.length).toBe(3); // t=0, 1000, 2000 locked; t=3000 expired
    expect(ran).toBe(1);
    expect(result.skipped).toBe(3);
  });

  it("releases the lock after a run, but never a lock another holder took over", async () => {
    const h = harness({
      lockTtlMs: 500,
      job: async () => {
        // the job outlives its TTL; another process takes the lock
        h.time.advance(1000);
        await h.store.putIfAbsent("runner:lock:poll", { holder: "thief" }, { ttlMs: 60_000 });
        h.ac.abort();
      },
    });
    await runUnattended(h.opts);
    expect(await h.store.get("runner:lock:poll")).toEqual({ holder: "thief" });

    const h2 = harness({ job: async () => void h2.ac.abort() });
    await runUnattended(h2.opts);
    expect(await h2.store.exists("runner:lock:poll")).toBe(false);
  });

  it("releases the lock when the job throws", async () => {
    let n = 0;
    const h = harness({
      maxConsecutiveFailures: 5,
      job: async () => {
        if (++n === 1) throw new Error("boom");
        h.ac.abort();
      },
    });
    await runUnattended(h.opts);
    expect(n).toBe(2); // the second run could take the lock
  });

  it("backs off exponentially on failure, capped, and resets after a success", async () => {
    const outcomes = [false, false, false, false, true, false];
    let i = 0;
    const h = harness({
      backoff: { baseMs: 100, factor: 2, maxMs: 350 },
      maxConsecutiveFailures: 10,
      job: async () => {
        const ok = outcomes[i++];
        if (i === outcomes.length) h.ac.abort();
        if (!ok) throw new Error("fail");
      },
    });
    await runUnattended(h.opts);
    expect(h.sleeps).toEqual([100, 200, 350, 350, 1000]);
  });

  it("fails visibly after N consecutive failures: event, last error, no further runs", async () => {
    let n = 0;
    const boom = new Error("upstream 500");
    const h = harness({
      maxConsecutiveFailures: 3,
      job: async () => {
        n++;
        throw boom;
      },
    });
    const result = await runUnattended(h.opts);
    expect(n).toBe(3);
    expect(result.reason).toBe("failure_limit");
    expect(result.lastError).toBe(boom);
    expect(result.consecutiveFailures).toBe(3);
    const types = h.events.map((e) => e.type);
    expect(types.filter((t) => t === "failure").length).toBe(3);
    expect(types).toContain("failure_limit");
    expect(types.at(-1)).toBe("stopped");
  });

  it("aborts an in-flight sleep promptly", async () => {
    const h = harness({ job: async () => {} });
    let release!: () => void;
    h.opts.clock = { now: () => 0, sleep: () => new Promise<void>((r) => (release = r)) };
    const p = runUnattended(h.opts);
    await new Promise((r) => setTimeout(r, 5));
    h.ac.abort();
    expect((await p).reason).toBe("aborted");
    release();
  });

  it("passes the abort signal to the job and waits for the in-flight job on shutdown", async () => {
    let sawSignal: AbortSignal | undefined;
    let finished = false;
    const h = harness({
      job: async (signal) => {
        sawSignal = signal;
        h.ac.abort();
        await new Promise((r) => setTimeout(r, 5));
        finished = true;
      },
    });
    const result = await runUnattended(h.opts);
    expect(finished).toBe(true);
    expect(sawSignal?.aborted).toBe(true);
    expect(result.runs).toBe(1);
  });

  it("rejects invalid options", async () => {
    const h = harness({ job: async () => {} });
    await expect(runUnattended({ ...h.opts, intervalMs: 0 })).rejects.toThrow(/intervalMs/);
    await expect(runUnattended({ ...h.opts, jitterRatio: 1.5 })).rejects.toThrow(/jitterRatio/);
    await expect(runUnattended({ ...h.opts, maxConsecutiveFailures: 0 })).rejects.toThrow(
      /maxConsecutiveFailures/,
    );
  });
});
