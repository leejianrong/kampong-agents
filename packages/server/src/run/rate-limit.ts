// KAM-322: a small in-memory token bucket for the public webhook ingress. Each key (a deployment id, a client
// address) has `capacity` tokens that refill at `perMinute / 60` a second; a request takes one or is refused with
// the number of seconds until one is free.
//
// It is per process. With two replicas a key can be served about twice its rate, which is the accepted cost of
// not adding a shared store for a first limit; a shared limiter is a later card if it matters.

export interface RateLimiterOptions {
  /** Sustained allowance, requests per minute. */
  perMinute: number;
  /** Largest burst. Defaults to a quarter of a minute's allowance, at least 1. */
  capacity?: number;
  /** Keys kept at once. Past this, full (idle) buckets go first, then the oldest. Bounds memory under random keys. */
  maxKeys?: number;
  /** Clock seam for tests, milliseconds. */
  now?: () => number;
}

export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly ratePerMs: number;
  private readonly capacity: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor({ perMinute, capacity, maxKeys, now }: RateLimiterOptions) {
    this.ratePerMs = perMinute / 60_000;
    this.capacity = capacity ?? Math.max(1, Math.ceil(perMinute / 4));
    this.maxKeys = maxKeys ?? 10_000;
    this.now = now ?? Date.now;
  }

  take(key: string): RateDecision {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (t - bucket.at) * this.ratePerMs);
    bucket.at = t;
    // Re-insert so Map order is least recently used first.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    this.trim(t);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / this.ratePerMs / 1000)),
    };
  }

  private trim(t: number): void {
    if (this.buckets.size <= this.maxKeys) return;
    for (const [key, b] of this.buckets) {
      if (this.buckets.size <= this.maxKeys) return;
      if (b.tokens + (t - b.at) * this.ratePerMs >= this.capacity) this.buckets.delete(key);
    }
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) return;
      this.buckets.delete(key);
    }
  }
}

export interface IngressLimits {
  /** Requests per minute to one deployment's webhook. */
  deploymentPerMinute: number;
  /** Requests per minute from one client address to any webhook. */
  ipPerMinute: number;
  /** Largest accepted request body, bytes. */
  maxBodyBytes: number;
}

export const DEFAULT_INGRESS_LIMITS: IngressLimits = {
  deploymentPerMinute: 120,
  ipPerMinute: 600,
  maxBodyBytes: 256 * 1024,
};
