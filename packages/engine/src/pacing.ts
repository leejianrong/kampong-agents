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

export class Pacer {
  private readonly nextSlot = new Map<string, number>();

  constructor(private readonly clock: Clock = realClock) {}

  /** Resolves when the caller may send. Each caller claims the next free slot, so a burst queues. */
  async wait(key: string, rps: number): Promise<void> {
    const interval = 1000 / rps;
    const now = this.clock.now();
    const slot = Math.max(now, this.nextSlot.get(key) ?? 0);
    this.nextSlot.set(key, slot + interval);
    const delay = slot - now;
    if (delay > 0) await this.clock.sleep(delay);
  }
}

/** Shared by every call that does not supply its own, so hosts are paced process-wide. */
export const defaultPacer = new Pacer();
