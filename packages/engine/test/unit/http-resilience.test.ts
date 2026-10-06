import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@kampong/spec";
import { callHttpTool, ToolCallError } from "../../src/http-tool.js";
import { Pacer, type Clock } from "../../src/pacing.js";

// KAN-1846 (ADR-0029): failure detection on a 200 body, per-host pacing, and retry with backoff.
// A fake clock keeps every test deterministic: nothing here really sleeps.

type HttpTool = Extract<Tool, { action: "http_request" }>;

function tool(overrides: Partial<HttpTool> = {}): HttpTool {
  return {
    name: "fetch_prices",
    action: "http_request",
    method: "GET",
    url: "https://api.example.test/query",
    ...overrides,
  };
}

function fakeClock({ advanceOnSleep = true } = {}) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (advanceOnSleep) now += ms;
    },
  };
  return { clock, sleeps, advance: (ms: number) => (now += ms) };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

async function failure(promise: Promise<unknown>): Promise<ToolCallError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ToolCallError);
  return error as ToolCallError;
}

describe("failure_when -- a 200 response that is really a failure", () => {
  const alphaVantage = tool({
    failure_when: [
      { path: "Note", exists: true, message_path: "Note", retryable: true },
      { path: '["Error Message"]', exists: true, message_path: '["Error Message"]' },
      { path: "Information", exists: true },
    ],
  });

  it("returns the body normally when no rule fires", async () => {
    const fetchImpl = vi.fn(async () => json({ "Time Series (Daily)": { a: 1 } }));

    await expect(callHttpTool(alphaVantage, {}, { fetchImpl })).resolves.toEqual({
      "Time Series (Daily)": { a: 1 },
    });
  });

  it("turns a rate-limit Note on HTTP 200 into a visible, retryable failure carrying the reason", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ Note: "Thank you for using Alpha Vantage! 5 calls per minute." }),
    );

    const error = await failure(callHttpTool(alphaVantage, {}, { fetchImpl }));

    expect(error.code).toBe("failure_when");
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/fetch_prices/);
    expect(error.message).toMatch(/5 calls per minute/);
  });

  it("reads a key with a space via a quoted path, and defaults to not retryable", async () => {
    const fetchImpl = vi.fn(async () => json({ "Error Message": "Invalid API call." }));

    const error = await failure(callHttpTool(alphaVantage, {}, { fetchImpl }));

    expect(error.message).toMatch(/Invalid API call/);
    expect(error.retryable).toBe(false);
  });

  it("supports equals, a numeric index and matches", async () => {
    const equals = tool({ failure_when: [{ path: "ok", equals: false, message_path: "error" }] });
    const indexed = tool({ failure_when: [{ path: "errors[0].code", exists: true }] });
    const matching = tool({ failure_when: [{ path: "status", matches: "^(error|fail)" }] });

    expect(
      (
        await failure(
          callHttpTool(
            equals,
            {},
            { fetchImpl: async () => json({ ok: false, error: "channel_not_found" }) },
          ),
        )
      ).message,
    ).toMatch(/channel_not_found/);
    await failure(
      callHttpTool(indexed, {}, { fetchImpl: async () => json({ errors: [{ code: 7 }] }) }),
    );
    await failure(
      callHttpTool(matching, {}, { fetchImpl: async () => json({ status: "error: bad" }) }),
    );
    await expect(
      callHttpTool(equals, {}, { fetchImpl: async () => json({ ok: true }) }),
    ).resolves.toEqual({ ok: true });
  });

  it("does not trip on a missing path for exists:false semantics (absent is not a failure)", async () => {
    const t = tool({ failure_when: [{ path: "Note", exists: true }] });

    await expect(
      callHttpTool(t, {}, { fetchImpl: async () => json({ fine: 1 }) }),
    ).resolves.toEqual({ fine: 1 });
  });

  it("never leaks a secret echoed in the failure message", async () => {
    const t = tool({
      headers: { Authorization: "Bearer ${TOK}" },
      failure_when: [{ path: "error", exists: true, message_path: "error" }],
    });
    const fetchImpl = vi.fn(async () => json({ error: "bad token tok-777" }));

    const error = await failure(
      callHttpTool(t, {}, { fetchImpl, env: { TOK: "tok-777" } as NodeJS.ProcessEnv }),
    );

    expect(error.message).not.toContain("tok-777");
  });
});

describe("retry", () => {
  const retry = { max: 3, backoff: "exponential" as const, base_ms: 100 };

  it("retries a retryable failure with exponential backoff and then succeeds", async () => {
    const { clock, sleeps } = fakeClock();
    const responses = [
      () => json({ Note: "slow down" }),
      () => json({ Note: "slow down" }),
      () => json({ ok: 1 }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!());
    const t = tool({
      retry,
      failure_when: [{ path: "Note", exists: true, retryable: true }],
    });

    const result = await callHttpTool(t, {}, { fetchImpl, clock, pacer: new Pacer(clock) });

    expect(result).toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("fails visibly with the attempt count once retries are exhausted", async () => {
    const { clock, sleeps } = fakeClock();
    const fetchImpl = vi.fn(
      async () => new Response("no", { status: 503, statusText: "Unavailable" }),
    );

    const error = await failure(
      callHttpTool(
        tool({ retry: { max: 2, backoff: "fixed", base_ms: 50 } }),
        {},
        { fetchImpl, clock, pacer: new Pacer(clock) },
      ),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([50, 50]);
    expect(error.message).toMatch(/after 3 attempts/);
  });

  it("honours Retry-After (seconds) when it is longer than the backoff", async () => {
    const { clock, sleeps } = fakeClock();
    const responses = [
      () => new Response("slow", { status: 429, headers: { "retry-after": "2" } }),
      () => json({ ok: 1 }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!());

    await callHttpTool(tool({ retry }), {}, { fetchImpl, clock, pacer: new Pacer(clock) });

    expect(sleeps).toEqual([2000]);
  });

  it("gives up rather than wait when Retry-After exceeds max_delay_ms", async () => {
    const { clock, sleeps } = fakeClock();
    const fetchImpl = vi.fn(
      async () => new Response("slow", { status: 429, headers: { "retry-after": "600" } }),
    );

    const error = await failure(
      callHttpTool(
        tool({ retry: { ...retry, max_delay_ms: 5000 } }),
        {},
        { fetchImpl, clock, pacer: new Pacer(clock) },
      ),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(error.code).toBe("rate_limit");
    expect(error.message).toMatch(/Retry-After/);
  });

  it("does not retry a client error such as 404 or 401", async () => {
    const { clock } = fakeClock();
    for (const status of [400, 401, 404]) {
      const fetchImpl = vi.fn(async () => new Response("x", { status }));
      const error = await failure(
        callHttpTool(tool({ retry }), {}, { fetchImpl, clock, pacer: new Pacer(clock) }),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(error.retryable).toBe(false);
    }
  });

  it("retries a POST only on 429, never on a 5xx or network error that may have been processed", async () => {
    const { clock } = fakeClock();
    const post = tool({ method: "POST", body: { json: { a: 1 } }, retry });

    const serverError = vi.fn(async () => new Response("x", { status: 500 }));
    await failure(
      callHttpTool(post, {}, { fetchImpl: serverError, clock, pacer: new Pacer(clock) }),
    );
    expect(serverError).toHaveBeenCalledTimes(1);

    const networkDown = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await failure(
      callHttpTool(post, {}, { fetchImpl: networkDown, clock, pacer: new Pacer(clock) }),
    );
    expect(networkDown).toHaveBeenCalledTimes(1);

    const responses = [() => new Response("x", { status: 429 }), () => json({ ok: 1 })];
    const limited = vi.fn(async () => responses.shift()!());
    await expect(
      callHttpTool(post, {}, { fetchImpl: limited, clock, pacer: new Pacer(clock) }),
    ).resolves.toEqual({ ok: 1 });
    expect(limited).toHaveBeenCalledTimes(2);
  });

  it("retries a GET on a network error", async () => {
    const { clock } = fakeClock();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNRESET");
      return json({ ok: 1 });
    });

    await expect(
      callHttpTool(tool({ retry }), {}, { fetchImpl, clock, pacer: new Pacer(clock) }),
    ).resolves.toEqual({ ok: 1 });
  });

  it("does nothing extra when no retry is configured (one attempt, original error text)", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", { status: 500, statusText: "Boom" }));

    await expect(callHttpTool(tool(), {}, { fetchImpl })).rejects.toThrow(/500 Boom/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("pace", () => {
  it("spaces calls to one host by 1/rps, and does not delay the first", async () => {
    const { clock, sleeps } = fakeClock();
    const pacer = new Pacer(clock);
    const fetchImpl = vi.fn(async () => json({}));
    const t = tool({ pace: { rps: 2 } });

    await callHttpTool(t, {}, { fetchImpl, clock, pacer });
    await callHttpTool(t, {}, { fetchImpl, clock, pacer });
    await callHttpTool(t, {}, { fetchImpl, clock, pacer });

    expect(sleeps).toEqual([500, 500]);
  });

  it("paces concurrent callers one after another instead of letting them all through", async () => {
    // Time does not advance while they wait, as with real concurrent callers.
    const { clock, sleeps } = fakeClock({ advanceOnSleep: false });
    const pacer = new Pacer(clock);
    const fetchImpl = vi.fn(async () => json({}));
    const t = tool({ pace: { rps: 1 } });

    await Promise.all([1, 2, 3].map(() => callHttpTool(t, {}, { fetchImpl, clock, pacer })));

    expect(sleeps.sort((a, b) => a - b)).toEqual([1000, 2000]);
  });

  it("keeps hosts independent, and skips pacing entirely when not configured", async () => {
    const { clock, sleeps } = fakeClock();
    const pacer = new Pacer(clock);
    const fetchImpl = vi.fn(async () => json({}));

    await callHttpTool(tool({ pace: { rps: 1 } }), {}, { fetchImpl, clock, pacer });
    await callHttpTool(
      tool({ url: "https://other.example.test/x", pace: { rps: 1 } }),
      {},
      { fetchImpl, clock, pacer },
    );
    await callHttpTool(tool(), {}, { fetchImpl, clock, pacer });
    await callHttpTool(tool(), {}, { fetchImpl, clock, pacer });

    expect(sleeps).toEqual([]);
  });

  it("counts retries against the pace too", async () => {
    const { clock, sleeps } = fakeClock();
    const responses = [() => new Response("x", { status: 503 }), () => json({ ok: 1 })];
    const fetchImpl = vi.fn(async () => responses.shift()!());
    const t = tool({ pace: { rps: 1 }, retry: { max: 2, backoff: "fixed", base_ms: 100 } });

    await callHttpTool(t, {}, { fetchImpl, clock, pacer: new Pacer(clock) });

    // 100ms backoff elapses first; pacing then tops the gap up to a full second.
    expect(sleeps).toEqual([100, 900]);
  });
});
