import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/run/rate-limit.js";

describe("RateLimiter (KAM-322)", () => {
  it("allows a burst up to capacity, then refuses with a retry time", () => {
    const t = 0;
    const limiter = new RateLimiter({ perMinute: 60, capacity: 3, now: () => t });
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it("refills at the sustained rate", () => {
    let t = 0;
    const limiter = new RateLimiter({ perMinute: 60, capacity: 1, now: () => t });
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
    t = 1_000; // 60 a minute is one a second
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
  });

  it("keeps keys apart", () => {
    const limiter = new RateLimiter({ perMinute: 60, capacity: 1, now: () => 0 });
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("b").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
  });

  it("reports a longer wait when the rate is slow", () => {
    const limiter = new RateLimiter({ perMinute: 6, capacity: 1, now: () => 0 });
    limiter.take("a");
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 10 });
  });

  it("stays bounded when callers use endless random keys", () => {
    let t = 0;
    const limiter = new RateLimiter({ perMinute: 60, capacity: 1, maxKeys: 50, now: () => t });
    for (let i = 0; i < 5_000; i++) {
      t += 1;
      limiter.take(`k${i}`);
    }
    // Private by design; the cap is what is under test.
    expect(
      (limiter as unknown as { buckets: Map<string, unknown> }).buckets.size,
    ).toBeLessThanOrEqual(50);
  });
});
