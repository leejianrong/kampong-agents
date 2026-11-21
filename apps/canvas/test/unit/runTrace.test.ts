import { describe, expect, it } from "vitest";
import type { RunTrace, TraceSpan } from "../../src/api.js";
import { buildTimeline, displayName, formatCost, formatDuration } from "../../src/runTrace.js";

// KAM-258: the Timeline view's data. A non-technical tester must be able to read off which step was slow, which
// used the most, and which failed, from the plain-words facts alone.

const span = (over: Partial<TraceSpan> & Pick<TraceSpan, "id" | "name" | "kind">): TraceSpan => ({
  status: "ok",
  startedAt: 0,
  ...over,
});

const trace = (spans: TraceSpan[], over: Partial<RunTrace> = {}): RunTrace => ({
  id: "t",
  status: "ok",
  startedAt: 0,
  endedAt: 10_000,
  spans,
  totals: { inputTokens: 0, outputTokens: 0, modelCalls: 0 },
  ...over,
});

const root = span({ id: "r", name: "agent", kind: "run", endedAt: 10_000, durationMs: 10_000 });

describe("buildTimeline", () => {
  it("places bars on a shared axis and nests a model call under its step", () => {
    const t = buildTimeline(
      trace([
        root,
        span({
          id: "a",
          parentId: "r",
          name: "draft",
          kind: "llm",
          startedAt: 1000,
          endedAt: 5000,
        }),
        span({
          id: "m",
          parentId: "a",
          name: "gpt-x",
          kind: "model",
          model: "gpt-x",
          startedAt: 1100,
          endedAt: 4900,
          usage: { inputTokens: 900, outputTokens: 100 },
          costUsd: 0.0016,
        }),
      ]),
    );
    expect(t.rows.map((r) => [r.label, r.kindLabel, r.depth])).toEqual([
      ["draft", "AI step", 0],
      ["gpt-x", "AI call", 1],
    ]);
    expect(t.rows[0]).toMatchObject({ leftPct: 10, widthPct: 40, durationMs: 4000 });
    expect(t.rows[1]?.tokens).toBe(1000);
  });

  it("names the slowest step by its own time, not time spent waiting for a person", () => {
    const t = buildTimeline(
      trace([
        root,
        span({ id: "a", parentId: "r", name: "fetch", kind: "tool", startedAt: 0, endedAt: 2000 }),
        span({
          id: "b",
          parentId: "r",
          name: "ok_to_send",
          kind: "approval",
          startedAt: 2000,
          endedAt: 9000,
          waitedMs: 7000,
        }),
        span({
          id: "c",
          parentId: "r",
          name: "shape",
          kind: "transform",
          startedAt: 9000,
          endedAt: 9100,
        }),
      ]),
    );
    const texts = t.facts.map((f) => f.text);
    expect(texts).toContain('Slowest step: "fetch", 2.0 s.');
    expect(texts).toContain("Waited 7.0 s for a person to decide.");
  });

  it("names the failing step and its message", () => {
    const t = buildTimeline(
      trace(
        [
          root,
          span({
            id: "a",
            parentId: "r",
            name: "fetch",
            kind: "tool",
            status: "error",
            endedAt: 500,
            error: "HTTP 429 from the API",
          }),
        ],
        { status: "error" },
      ),
    );
    expect(t.facts[0]).toEqual({
      tone: "error",
      text: 'Stopped at "fetch": HTTP 429 from the API',
    });
  });

  it("says a failed loop item did not stop the run", () => {
    const t = buildTimeline(
      trace([
        root,
        span({
          id: "a",
          parentId: "r",
          name: "each[1].fetch",
          kind: "tool",
          status: "error",
          endedAt: 500,
          error: "HTTP 500",
        }),
      ]),
    );
    expect(t.facts[0]).toEqual({
      tone: "warn",
      text: '1 step failed but the run carried on. First: "fetch, item 2": HTTP 500',
    });
  });

  it("says which step used the most tokens, summing a step's repeated calls", () => {
    const call = (id: string, parent: string, tokens: number): TraceSpan =>
      span({
        id,
        parentId: parent,
        name: "m",
        kind: "model",
        endedAt: 1,
        usage: { inputTokens: tokens, outputTokens: 0 },
      });
    const t = buildTimeline(
      trace(
        [
          root,
          span({ id: "a", parentId: "r", name: "triage", kind: "llm", endedAt: 1 }),
          span({ id: "b", parentId: "r", name: "reply", kind: "llm", endedAt: 1 }),
          call("m1", "a", 300),
          call("m2", "a", 300),
          call("m3", "b", 500),
        ],
        { totals: { inputTokens: 1100, outputTokens: 0, modelCalls: 3 } },
      ),
    );
    expect(t.facts.map((f) => f.text)).toContain('Used the most: "triage", 600 tokens.');
  });

  it("says there is no cost estimate rather than inventing one", () => {
    const t = buildTimeline(
      trace([root], { totals: { inputTokens: 1200, outputTokens: 300, modelCalls: 1 } }),
    );
    expect(t.facts.at(-1)?.text).toBe(
      "1,500 tokens. No price is set for this model, so there is no cost estimate.",
    );
    expect(t.costUsd).toBeUndefined();
  });

  it("reports a cost when the trace has one", () => {
    const t = buildTimeline(
      trace([root], {
        totals: { inputTokens: 1, outputTokens: 1, modelCalls: 1, costUsd: 0.0042 },
      }),
    );
    expect(t.facts.at(-1)?.text).toBe("Estimated cost $0.0042.");
  });

  it("measures a run still going against the clock it is given", () => {
    const t = buildTimeline(
      trace(
        [
          { ...root, endedAt: undefined, durationMs: undefined, status: "running" },
          span({
            id: "a",
            parentId: "r",
            name: "fetch",
            kind: "tool",
            status: "running",
            startedAt: 2000,
          }),
        ],
        { endedAt: undefined, status: "running" },
      ),
      4000,
    );
    expect(t.totalMs).toBe(4000);
    expect(t.rows[0]).toMatchObject({ status: "running", widthPct: 50 });
    expect(t.rows[0]?.durationMs).toBeUndefined();
  });
});

describe("formatting", () => {
  it("formats durations and costs", () => {
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(4200)).toBe("4.2 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(formatCost(0.0016)).toBe("$0.0016");
    expect(formatCost(1.5)).toBe("$1.50");
  });
});

describe("buildTimeline: loops, names, quick steps, Replay (KAM-274)", () => {
  const loop = span({ id: "l", parentId: "r", name: "each", kind: "foreach", endedAt: 900 });
  const item = (n: number, over: Partial<TraceSpan> = {}): TraceSpan =>
    span({
      id: `i${n}`,
      parentId: "l",
      name: `each[${n}].fetch`,
      kind: "tool",
      startedAt: 10 * n,
      endedAt: 10 * n + 5,
      ...over,
    });

  it("names an item step as a person would, not by its engine id", () => {
    expect(displayName("each_symbol[0].fetch")).toBe("fetch, item 1");
    expect(displayName("plain")).toBe("plain");
  });

  it("folds a loop's items into its row and keeps only the failed ones listed", () => {
    const t = buildTimeline(
      trace([root, loop, item(0), item(1, { status: "error", error: "429" }), item(2)]),
    );
    expect(t.rows.map((r) => r.label)).toEqual(["each", "fetch, item 2"]);
    expect(t.rows[0]).toMatchObject({
      note: "3 items",
      status: "error",
      statusWord: "Done, 1 of 3 failed",
    });
    const all = buildTimeline(trace([root, loop, item(0), item(1), item(2)]), 0, {
      showAll: true,
    });
    expect(all.rows).toHaveLength(4);
  });

  it("gives no duration to a step under 100 ms", () => {
    const t = buildTimeline(
      trace([root, span({ id: "q", parentId: "r", name: "fast", kind: "tool", endedAt: 40 })]),
    );
    expect(t.rows[0]?.durationMs).toBeUndefined();
    const slow = buildTimeline(
      trace([root, span({ id: "q", parentId: "r", name: "slow", kind: "tool", endedAt: 400 })]),
    );
    expect(slow.rows[0]?.durationMs).toBe(400);
  });

  it("says nothing about tokens or price in a Replay run", () => {
    const withCalls = trace(
      [
        root,
        span({ id: "m", parentId: "r", name: "gpt-x", kind: "model", model: "gpt-x", endedAt: 50 }),
      ],
      { totals: { inputTokens: 0, outputTokens: 0, modelCalls: 1 } },
    );
    expect(
      buildTimeline(withCalls)
        .facts.map((f) => f.text)
        .join(" "),
    ).toContain("did not report");
    expect(
      buildTimeline(withCalls, 0, { replay: true })
        .facts.map((f) => f.text)
        .join(" "),
    ).not.toContain("did not report");
  });
});
