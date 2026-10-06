// Vendored from packages/engine/src/pacing.ts as part of a `kampong export`
// -- see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. It is
// copied unchanged. From here on this file is yours: it will not be touched
// again by a future export.
//
// Per-key request pacing (KAN-1846). A tool that declares `pace: { rps }` is held to at most that many
// requests per second against the same host, including across concurrent callers and retries.
// Time is injected so tests never really sleep.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A clock that never waits: for replaying recorded fixtures, where real backoff delays only slow tests. */
export const instantClock: Clock = {
  now: () => Date.now(),
  sleep: async () => {},
};

export class Pacer {
  private readonly nextSlot = new Map<string, number>();
  private readonly slowestRps = new Map<string, number>();

  constructor(private readonly clock: Clock = realClock) {}

  /**
   * Resolves when the caller may send. Each caller claims the next free slot, so a burst queues.
   * Tools that share a key (a host) are held to the slowest rate any of them declared, because the
   * host's limit is one number that no single tool knows.
   */
  async wait(key: string, rps: number): Promise<void> {
    const effective = Math.min(rps, this.slowestRps.get(key) ?? rps);
    this.slowestRps.set(key, effective);
    const interval = 1000 / effective;
    const now = this.clock.now();
    const slot = Math.max(now, this.nextSlot.get(key) ?? 0);
    this.nextSlot.set(key, slot + interval);
    const delay = slot - now;
    if (delay > 0) await this.clock.sleep(delay);
  }
}

/** Shared by every call that does not supply its own, so hosts are paced process-wide. */
export const defaultPacer = new Pacer();
