import { describe, expect, it } from "vitest";
import type { AgentSpec, WorkflowStep } from "@kampong/spec";
import { AgentRun } from "../../src/run.js";
import type { ModelClient } from "../../src/model.js";
import { createTraceRecorder, estimateCost, stepKind } from "../../src/trace.js";

// ADR-0063 / KAM-256: the trace is built from the run's events and the model client, with no change to the
// engine. A fake clock makes durations exact.

const TOOLS = [{ name: "log", action: "http_request", method: "GET", url: "https://t.test/log" }];

const spec = (workflow: unknown[]): AgentSpec =>
  ({
    version: "1.1",
    agent: {
      id: "tr",
      name: "Tr",
      role: "R",
      goal: "G",
      model: { provider: "openai", name: "gpt-x", api_key: "k" },
      tools: TOOLS,
      workflow,
    },
  }) as unknown as AgentSpec;

function clock() {
  let t = 1_000;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

const fetchImpl = (async () => new Response('{"ok":true}')) as unknown as typeof fetch;

function modelWith(
  c: ReturnType<typeof clock>,
  rec?: { reportUsage(u: { inputTokens?: number; outputTokens?: number }): void },
): ModelClient {
  return {
    async generateText() {
      c.tick(40);
      rec?.reportUsage({ inputTokens: 100, outputTokens: 20 });
      return "hello";
    },
    async generateStructured<T>() {
      c.tick(40);
      rec?.reportUsage({ inputTokens: 100, outputTokens: 20 });
      return { result: {}, confidence: 0.9 } as T;
    },
  };
}

describe("stepKind", () => {
  const kinds: [unknown, string][] = [
    [{ step: "a", action: "summarise" }, "llm"],
    [{ step: "a", action: "http_request" }, "tool"],
    [{ step: "a", action: "component" }, "tool"],
    [{ step: "a", type: "tool", tool: "log" }, "tool"],
    [{ step: "a", type: "condition", if: "x", then: "y", else: "z" }, "condition"],
    [{ step: "a", type: "approval" }, "approval"],
    [{ step: "a", type: "transform", set: { x: "1" } }, "transform"],
    [{ step: "a", type: "validate", assert: "true" }, "validate"],
    [{ step: "a", type: "dedupe", once: { key: "k", ttl: "1h" } }, "dedupe"],
    [{ step: "a", foreach: { items: "x", as: "i", steps: [] } }, "foreach"],
    [{ step: "a", branch: { if: "x", then: [] } }, "branch"],
    [{ step: "a", stop: {} }, "stop"],
  ];
  it.each(kinds)("classifies %j as %s", (step, kind) => {
    expect(stepKind(step as WorkflowStep)).toBe(kind);
  });
  it("falls back to step for an unknown name", () => {
    expect(stepKind(undefined)).toBe("step");
  });
});

describe("TraceRecorder", () => {
  it("records a root span, a step span per step, and a model span under the model step", async () => {
    const c = clock();
    const s = spec([
      { step: "draft", action: "summarise" },
      { step: "fetch", type: "tool", tool: "log" },
      { step: "shape", type: "transform", set: { n: "1" } },
    ]);
    const rec = createTraceRecorder(s, {
      now: c.now,
      id: "t1",
      pricing: { "gpt-x": { inputPerMTok: 10, outputPerMTok: 30 } },
    });
    const run = new AgentRun(s, { model: rec.wrapModel(modelWith(c, rec)), env: {}, fetchImpl });
    rec.attach(run);
    const state = await run.start("hi");

    const trace = rec.snapshot();
    expect(state.error).toBeUndefined();
    expect(trace.status).toBe("ok");
    expect(trace.spans.map((x) => [x.name, x.kind])).toEqual([
      ["tr", "run"],
      ["draft", "llm"],
      ["gpt-x", "model"],
      ["fetch", "tool"],
      ["shape", "transform"],
    ]);
    const root = trace.spans[0]!;
    const draft = trace.spans[1]!;
    const model = trace.spans[2]!;
    expect(draft.parentId).toBe(root.id);
    expect(model.parentId).toBe(draft.id);
    expect(model.durationMs).toBe(40);
    expect(model.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(model.costUsd).toBeCloseTo(0.0016);
    expect(trace.totals).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      modelCalls: 1,
      costUsd: model.costUsd,
    });
  });

  it("leaves the cost out when the model has no price, rather than guessing", async () => {
    const c = clock();
    const s = spec([{ step: "draft", action: "summarise" }]);
    const rec = createTraceRecorder(s, { now: c.now });
    const run = new AgentRun(s, { model: rec.wrapModel(modelWith(c, rec)), env: {}, fetchImpl });
    rec.attach(run);
    await run.start("hi");
    const model = rec.snapshot().spans.find((x) => x.kind === "model")!;
    expect(model.usage?.inputTokens).toBe(100);
    expect(model.costUsd).toBeUndefined();
    expect(rec.snapshot().totals.costUsd).toBeUndefined();
  });

  it("nests loop body steps under their foreach and marks a failure on the failing step", async () => {
    const c = clock();
    const s = spec([
      {
        step: "each",
        foreach: {
          items: "trigger.rows",
          as: "row",
          steps: [{ step: "shape", type: "transform", set: { n: "row" } }],
        },
      },
    ]);
    const rec = createTraceRecorder(s, { now: c.now });
    const run = new AgentRun(s, {
      model: rec.wrapModel(modelWith(c)),
      env: {},
      fetchImpl,
      trigger: { body: { rows: [1, 2] } },
    });
    rec.attach(run);
    await run.start("{}");
    const spans = rec.snapshot().spans;
    const each = spans.find((x) => x.name === "each")!;
    const shapes = spans.filter((x) => x.kind === "transform");
    expect(each.kind).toBe("foreach");
    expect(shapes).toHaveLength(2);
    expect(shapes.every((x) => x.parentId === each.id)).toBe(true);
  });

  it("marks a loop item that failed under on_error: continue, rather than calling it done", async () => {
    const c = clock();
    const s = spec([
      {
        step: "each",
        foreach: {
          items: "trigger.rows",
          as: "row",
          on_error: "continue",
          steps: [{ step: "fetch", type: "tool", tool: "log" }],
        },
      },
    ]);
    const rec = createTraceRecorder(s, { now: c.now });
    let calls = 0;
    const flaky = (async () =>
      ++calls === 2
        ? new Response("boom", { status: 500 })
        : new Response('{"ok":true}')) as unknown as typeof fetch;
    const run = new AgentRun(s, {
      model: rec.wrapModel(modelWith(c)),
      env: {},
      fetchImpl: flaky,
      trigger: { body: { rows: [1, 2, 3] } },
    });
    rec.attach(run);
    const state = await run.start("{}");
    expect(state.status).toBe("completed");
    const fetches = rec.snapshot().spans.filter((x) => x.kind === "tool");
    expect(fetches.map((x) => x.status)).toEqual(["ok", "error", "ok"]);
    expect(fetches[1]?.error).toBeTruthy();
    expect(rec.snapshot().spans.find((x) => x.kind === "foreach")?.status).toBe("ok");
  });

  it("separates human wait from machine time on an approval step", async () => {
    const c = clock();
    const s = spec([{ step: "ok_to_send", type: "approval", message: "Send it?" }]);
    const rec = createTraceRecorder(s, { now: c.now });
    const run = new AgentRun(s, { model: rec.wrapModel(modelWith(c)), env: {}, fetchImpl });
    rec.attach(run);
    await run.start("hi");
    expect(rec.snapshot().status).toBe("paused");
    c.tick(5_000);
    await run.resume(true);
    const trace = rec.snapshot();
    const approval = trace.spans.find((x) => x.kind === "approval")!;
    expect(trace.status).toBe("ok");
    expect(approval.status).toBe("ok");
    expect(approval.waitedMs).toBe(5_000);
    expect(approval.durationMs).toBe(5_000);
  });

  it("marks a rejected approval and the run as rejected", async () => {
    const c = clock();
    const s = spec([{ step: "ok_to_send", type: "approval" }]);
    const rec = createTraceRecorder(s, { now: c.now });
    const run = new AgentRun(s, { model: rec.wrapModel(modelWith(c)), env: {}, fetchImpl });
    rec.attach(run);
    await run.start("hi");
    await run.resume(false, "no");
    const trace = rec.snapshot();
    expect(trace.status).toBe("rejected");
    expect(trace.spans.find((x) => x.kind === "approval")?.status).toBe("rejected");
  });

  it("marks a failed model call as an error on the model span, the step and the run", async () => {
    const c = clock();
    const s = spec([{ step: "draft", action: "summarise" }]);
    const rec = createTraceRecorder(s, { now: c.now });
    const failing: ModelClient = {
      async generateText() {
        throw new Error("provider down");
      },
      async generateStructured() {
        throw new Error("provider down");
      },
    };
    const run = new AgentRun(s, { model: rec.wrapModel(failing), env: {}, fetchImpl });
    rec.attach(run);
    await run.start("hi");
    const trace = rec.snapshot();
    expect(trace.status).toBe("error");
    expect(trace.spans.find((x) => x.kind === "model")).toMatchObject({
      status: "error",
      error: "provider down",
    });
    expect(trace.spans.find((x) => x.kind === "llm")?.status).toBe("error");
  });

  it("does not store prompts or outputs", async () => {
    const c = clock();
    const s = spec([{ step: "draft", action: "summarise" }]);
    const rec = createTraceRecorder(s, { now: c.now });
    const run = new AgentRun(s, { model: rec.wrapModel(modelWith(c)), env: {}, fetchImpl });
    rec.attach(run);
    await run.start("a secret customer message");
    const json = JSON.stringify(rec.snapshot());
    expect(json).not.toContain("secret customer");
    expect(json).not.toContain("hello");
  });
});

describe("estimateCost", () => {
  it("is undefined without a price or usage", () => {
    expect(estimateCost(undefined, "m", { inputTokens: 1 })).toBeUndefined();
    expect(
      estimateCost({ m: { inputPerMTok: 1, outputPerMTok: 1 } }, "m", undefined),
    ).toBeUndefined();
  });
});
