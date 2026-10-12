import { describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { runWorkflow, type EngineDeps, type RunEvent } from "../../src/workflow.js";
import type { Clock } from "../../src/pacing.js";
import type { ModelClient } from "../../src/model.js";
import { SqliteStateStore } from "../../src/sqlite-state-store.js";

// KAN-1858 (ADR-0043): the foreach step. Deterministic: a fake fetch that answers per URL, a fake clock that
// records its sleeps, and a fake model. Nothing here really waits.

const model: ModelClient = {
  async generateText({ prompt }) {
    return `text for ${prompt.split("\n")[0]}`;
  },
  async generateStructured<T>() {
    return { result: {}, confidence: 1 } as T;
  },
};

function fakeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  return { clock, sleeps };
}

interface Call {
  method: string;
  url: string;
  body?: string;
}

/** A fetch that answers 200 `{price: n}` unless `answer` says otherwise, and records every call. */
function fakeFetch(answer: (call: Call) => Response | Promise<Response> = () => ok({ price: 1 })) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      ...(typeof init?.body === "string" && { body: init.body }),
    };
    calls.push(call);
    return answer(call);
  }) as unknown as NonNullable<EngineDeps["fetchImpl"]>;
  return { fetchImpl, calls };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const limited = () => new Response("slow down", { status: 429 });

const TOOLS = [
  {
    name: "fetch_price",
    action: "http_request",
    method: "GET",
    url: "https://api.test/price/{{ symbol }}",
  },
  {
    name: "store_row",
    action: "http_request",
    method: "POST",
    url: "https://db.test/rows",
    body: { json: { symbol: "{{ symbol }}", price: "{{ fetch.price }}" } },
  },
];

const STORE_STEPS = [
  { step: "fetch", type: "tool", tool: "fetch_price" },
  { step: "write", type: "tool", tool: "store_row" },
];

const make = (
  foreach: Record<string, unknown>,
  extra: { version?: string; after?: unknown[] } = {},
): AgentSpec =>
  ({
    version: extra.version ?? "1.1",
    agent: {
      id: "loop",
      name: "Loop",
      role: "R",
      goal: "G",
      tools: TOOLS,
      workflow: [
        {
          step: "each",
          foreach: { items: "trigger.symbols", as: "symbol", steps: STORE_STEPS, ...foreach },
        },
        ...(extra.after ?? []),
      ],
    },
  }) as unknown as AgentSpec;

async function drive(spec: AgentSpec, input: unknown, deps: Partial<EngineDeps> = {}) {
  const events: RunEvent[] = [];
  const gen = runWorkflow(spec, { model, env: {}, ...deps }, JSON.stringify(input));
  let next = await gen.next(undefined);
  while (!next.done) {
    events.push(next.value);
    next = await gen.next(undefined);
  }
  return events;
}
const last = (events: RunEvent[]) => events.at(-1)!;
const completed = (events: RunEvent[]) => {
  const e = last(events);
  expect(e.type, JSON.stringify(e)).toBe("completed");
  return (e as Extract<RunEvent, { type: "completed" }>).output;
};
const failedMessage = (events: RunEvent[]) => {
  const e = last(events);
  expect(e.type).toBe("failed");
  return (e as Extract<RunEvent, { type: "failed" }>).error;
};
type LoopOut = {
  results: Record<string, unknown>[];
  errors: { index: number; item: unknown; step: string; message: string }[];
  skipped: { index: number; item: unknown; step: string; reason: string }[];
  count: number;
};

const SYMBOLS = { symbols: ["AAA", "BBB", "CCC"] };
const rateLimitBBB = (call: Call) =>
  call.url.endsWith("/BBB") ? limited() : ok({ price: call.url.length });

describe("foreach: collecting", () => {
  it("runs the body once per item and collects each item's step outputs as an array", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const events = await drive(make({}), SYMBOLS, { fetchImpl });
    const out = completed(events).each as LoopOut;
    expect(out.count).toBe(3);
    expect(out.errors).toEqual([]);
    expect(out.results).toHaveLength(3);
    expect(out.results[0]).toHaveProperty("fetch");
    expect(out.results[0]).toHaveProperty("write");
    expect(calls.filter((c) => c.method === "POST").map((c) => JSON.parse(c.body!).symbol)).toEqual(
      ["AAA", "BBB", "CCC"],
    );
  });

  it("makes the loop variable and earlier body steps visible to expressions, and the result to later steps", async () => {
    const spec = make(
      {
        steps: [
          { step: "shape", type: "transform", set: { label: "symbol & '!'" } },
          { step: "again", type: "transform", set: { twice: "shape.label & shape.label" } },
        ],
      },
      {
        after: [{ step: "summary", type: "transform", set: { n: "$count(each.results)" } }],
      },
    );
    const out = completed(await drive(spec, SYMBOLS));
    expect((out.each as LoopOut).results.map((r) => r.again)).toEqual([
      { twice: "AAA!AAA!" },
      { twice: "BBB!BBB!" },
      { twice: "CCC!CCC!" },
    ]);
    expect(out.summary).toEqual({ n: 3 });
    // The loop variable and body names are not left behind in the run outputs.
    expect(out).not.toHaveProperty("symbol");
    expect(out).not.toHaveProperty("shape");
  });

  it("runs action steps in the body with the loop variable in the query", async () => {
    const prompts: string[] = [];
    const spec = make({
      steps: [{ step: "ask", action: "summarise", query: "about {{ symbol }}" }],
    });
    await drive(
      spec,
      { symbols: ["AAA"] },
      {
        model: {
          ...model,
          async generateText({ prompt }) {
            prompts.push(prompt);
            return "ok";
          },
        },
      },
    );
    expect(prompts[0]).toContain("Query: about AAA");
  });

  it("finishes with empty results for an empty list", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const out = completed(await drive(make({}), { symbols: [] }, { fetchImpl }));
    expect(out.each).toEqual({ results: [], errors: [], skipped: [], count: 0 });
    expect(calls).toEqual([]);
  });

  it("reports the loop and its body steps as events, with the item index in a nested step's name", async () => {
    const { fetchImpl } = fakeFetch();
    const events = await drive(make({}), { symbols: ["AAA"] }, { fetchImpl });
    const names = events
      .filter((e) => e.type === "step_started")
      .map((e) => (e as { step: string }).step);
    expect(names).toEqual(["each", "each[0].fetch", "each[0].write"]);
    expect(
      events.filter((e) => e.type === "step_completed").map((e) => (e as { step: string }).step),
    ).toEqual(["each[0].fetch", "each[0].write", "each"]);
  });
});

describe("foreach: items must be a list", () => {
  it.each([
    ["a text", "trigger.name", /must evaluate to a list, but it evaluated to a string/],
    ["an object", "trigger", /must evaluate to a list, but it evaluated to an object/],
    ["nothing", "trigger.nope", /evaluated to nothing/],
  ])("fails the run clearly when it evaluates to %s", async (_n, items, message) => {
    const { fetchImpl } = fakeFetch();
    const events = await drive(make({ items }), { name: "x" }, { fetchImpl });
    expect(failedMessage(events)).toMatch(message);
    expect(failedMessage(events)).toContain('Step "each"');
  });

  it("accepts a list with one element", async () => {
    const { fetchImpl } = fakeFetch();
    const out = completed(await drive(make({}), { symbols: ["ONE"] }, { fetchImpl }));
    expect((out.each as LoopOut).count).toBe(1);
  });
});

describe("foreach: on_error", () => {
  it("continue: a rate-limited item lands in errors[] and the others finish, with no partial row for it", async () => {
    const { fetchImpl, calls } = fakeFetch(rateLimitBBB);
    const events = await drive(make({ on_error: "continue" }), SYMBOLS, { fetchImpl });
    const out = completed(events).each as LoopOut;

    expect(out.count).toBe(3);
    expect(out.results).toHaveLength(2);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({ index: 1, item: "BBB", step: "fetch" });
    expect(out.errors[0]!.message).toMatch(/429/);

    // The write after the failing step never ran for BBB: no partial row.
    const writes = calls.filter((c) => c.method === "POST").map((c) => JSON.parse(c.body!).symbol);
    expect(writes).toEqual(["AAA", "CCC"]);
    // The other items did finish.
    expect(calls.filter((c) => c.url.endsWith("/CCC"))).toHaveLength(1);
  });

  it("fail (the default): the first failure ends the run, naming the item and the step, and later items do not start", async () => {
    const { fetchImpl, calls } = fakeFetch(rateLimitBBB);
    const events = await drive(make({}), SYMBOLS, { fetchImpl });
    const error = failedMessage(events);
    expect(error).toMatch(/each/);
    expect(error).toMatch(/item 1/);
    expect(error).toMatch(/fetch/);
    expect(error).toMatch(/429/);
    expect(calls.some((c) => c.url.endsWith("/CCC"))).toBe(false);
    expect(calls.filter((c) => c.method === "POST").map((c) => JSON.parse(c.body!).symbol)).toEqual(
      ["AAA"],
    );
  });

  it("retry: re-runs the failed step with backoff on the injected clock, and does not repeat earlier steps", async () => {
    const { clock, sleeps } = fakeClock();
    let bbb = 0;
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.url.endsWith("/BBB") && ++bbb <= 2) return limited();
      return ok({ price: 5 });
    });
    const spec = make({
      on_error: { retry: { n: 3, backoff: "exponential", base_ms: 100 } },
      steps: [{ step: "shape", type: "transform", set: { id: "symbol" } }, ...STORE_STEPS],
    });
    const out = completed(await drive(spec, SYMBOLS, { fetchImpl, clock })).each as LoopOut;
    expect(out.errors).toEqual([]);
    expect(out.results).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
    expect(calls.filter((c) => c.url.endsWith("/BBB"))).toHaveLength(3);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(3);
  });

  it("retry: when the retries run out the run fails by default, or the item is recorded with then: continue", async () => {
    const { clock, sleeps } = fakeClock();
    const retry = { n: 2, backoff: "fixed", base_ms: 50 };
    const a = fakeFetch(rateLimitBBB);
    const failed = await drive(make({ on_error: { retry } }), SYMBOLS, {
      fetchImpl: a.fetchImpl,
      clock,
    });
    expect(failedMessage(failed)).toMatch(/after 2 retries/);
    expect(sleeps).toEqual([50, 50]);

    const b = fakeFetch(rateLimitBBB);
    const out = completed(
      await drive(make({ on_error: { retry: { ...retry, then: "continue" } } }), SYMBOLS, {
        fetchImpl: b.fetchImpl,
        clock,
      }),
    ).each as LoopOut;
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]!.message).toMatch(/after 2 retries/);
    expect(out.results).toHaveLength(2);
  });

  it("retry does not repeat a deterministic failure of a data step", async () => {
    const { clock, sleeps } = fakeClock();
    const spec = make({
      on_error: { retry: { n: 3, base_ms: 10, then: "continue" } },
      steps: [{ step: "check", type: "validate", assert: "symbol = 'AAA'", message: "not AAA" }],
    });
    const out = completed(await drive(spec, SYMBOLS, { clock })).each as LoopOut;
    expect(sleeps).toEqual([]);
    expect(out.errors.map((e) => [e.index, e.step, e.message])).toEqual([
      [1, "check", "not AAA"],
      [2, "check", "not AAA"],
    ]);
  });

  it("a failing expression in the body is isolated like any other failure", async () => {
    const spec = make({
      on_error: "continue",
      steps: [{ step: "shape", type: "transform", set: { v: "symbol.missing.deeper" } }],
    });
    const out = completed(await drive(spec, SYMBOLS)).each as LoopOut;
    expect(out.results).toEqual([]);
    expect(out.errors).toHaveLength(3);
    expect(out.errors[0]!.message).toMatch(/evaluated to nothing/);
  });

  it("goto is refused if it reaches the engine unvalidated", async () => {
    const events = await drive(make({ on_error: "goto" }), SYMBOLS);
    expect(failedMessage(events)).toMatch(/goto is not yet supported/);
  });
});

describe("foreach: skipping an item", () => {
  it("a validate with on_fail: skip ends that item only, and a dedupe duplicate does the same", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const spec = make({
      steps: [
        {
          step: "check",
          type: "validate",
          assert: "symbol != 'BBB'",
          on_fail: "skip",
          message: "no BBB",
        },
        { step: "fetch", type: "tool", tool: "fetch_price" },
      ],
    });
    const out = completed(
      await drive(spec, SYMBOLS, {
        fetchImpl,
      }),
    ).each as LoopOut;
    expect(out.skipped).toEqual([{ index: 1, item: "BBB", step: "check", reason: "no BBB" }]);
    expect(out.results).toHaveLength(2);
    expect(out.errors).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.test/price/AAA",
      "https://api.test/price/CCC",
    ]);
  });
});

describe("foreach: dedupe in the body", () => {
  it("a duplicate key skips that item only, and the key is remembered across runs", async () => {
    const spec = make({
      steps: [
        { step: "seen", type: "dedupe", once: { key: "symbol", ttl: "1h" } },
        { step: "fetch", type: "tool", tool: "fetch_price" },
      ],
    });
    const store = new SqliteStateStore({ path: ":memory:" });
    const a = fakeFetch();
    const first = completed(
      await drive(
        spec,
        { symbols: ["AAA", "BBB", "AAA"] },
        { fetchImpl: a.fetchImpl, state: store },
      ),
    ).each as LoopOut;
    expect(first.skipped.map((s) => [s.index, s.item, s.step])).toEqual([[2, "AAA", "seen"]]);
    expect(a.calls.map((c) => c.url)).toEqual([
      "https://api.test/price/AAA",
      "https://api.test/price/BBB",
    ]);
    const b = fakeFetch();
    const second = completed(
      await drive(spec, { symbols: ["AAA", "CCC"] }, { fetchImpl: b.fetchImpl, state: store }),
    ).each as LoopOut;
    expect(second.skipped).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    await store.close();
  });
});

describe("foreach: bounded concurrency", () => {
  it("never has more items in flight than `concurrency`, and still collects results in item order", async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const { fetchImpl } = fakeFetch(async (call) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Hold every call until the test lets it go, so overlap is real.
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight--;
      return ok({ price: Number(call.url.at(-1)) });
    });
    const spec = make({
      concurrency: 2,
      steps: [{ step: "fetch", type: "tool", tool: "fetch_price" }],
    });
    const run = drive(spec, { symbols: ["1", "2", "3", "4", "5"] }, { fetchImpl });
    // Release calls one at a time until the run ends.
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 1));
      releases.shift()?.();
    }
    const out = completed(await run).each as LoopOut;
    expect(peak).toBe(2);
    expect(out.results.map((r) => (r.fetch as { price: number }).price)).toEqual([1, 2, 3, 4, 5]);
  });

  it("with fail and concurrency, stops starting items after the first failure", async () => {
    const { fetchImpl, calls } = fakeFetch((call) =>
      call.url.endsWith("/1") ? limited() : ok({ price: 1 }),
    );
    const spec = make({
      concurrency: 2,
      steps: [{ step: "fetch", type: "tool", tool: "fetch_price" }],
    });
    const events = await drive(spec, { symbols: ["1", "2", "3", "4", "5", "6"] }, { fetchImpl });
    expect(failedMessage(events)).toMatch(/item 0/);
    expect(calls.length).toBeLessThan(6);
  });
});

describe("foreach: what it does not do", () => {
  it("needs version 1.1", async () => {
    const events = await drive(make({}, { version: "1.0" }), SYMBOLS);
    expect(failedMessage(events)).toMatch(/foreach needs version "1.1"/);
  });

  it("fails an item that would need an approval, instead of pausing the run", async () => {
    const spec = make({
      on_error: "continue",
      steps: [{ step: "ask", type: "approval", message: "ok?" }],
    });
    const out = completed(await drive(spec, { symbols: ["AAA"] })).each as LoopOut;
    expect(out.errors[0]!.message).toMatch(/approval is not supported inside a foreach/);
  });

  it("fails an item whose tool requires approval", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const spec = make({ on_error: "continue" });
    (spec.agent.tools as unknown as { requires_approval?: boolean }[])[1]!.requires_approval = true;
    const out = completed(await drive(spec, { symbols: ["AAA"] }, { fetchImpl })).each as LoopOut;
    expect(out.errors[0]).toMatchObject({ step: "write" });
    expect(out.errors[0]!.message).toMatch(/approval is not supported inside a foreach/);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("refuses a nested foreach if it reaches the engine unvalidated", async () => {
    const spec = make({
      on_error: "continue",
      steps: [{ step: "deep", foreach: { items: "[1]", as: "j", steps: [] } }],
    });
    const out = completed(await drive(spec, { symbols: ["AAA"] })).each as LoopOut;
    expect(out.errors[0]!.message).toMatch(/foreach inside a foreach is not supported/);
  });
});
