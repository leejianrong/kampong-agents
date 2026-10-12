import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { runWorkflow, type EngineDeps, type RunEvent } from "../../src/workflow.js";
import { createAgentRun } from "../../src/run.js";
import { SqliteStateStore } from "../../src/sqlite-state-store.js";
import type { ModelClient } from "../../src/model.js";
import { createFakeClock } from "./state-store-contract.js";

// KAN-1860: transform, validate and dedupe steps in a version 1.1 spec. Deterministic: a fake model, a
// fake clock for the store, and a real file-backed SQLite store for the restart test.

const dir = mkdtempSync(join(tmpdir(), "kampong-data-steps-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const model: ModelClient = {
  async generateText() {
    return "text";
  },
  async generateStructured<T>() {
    return { result: {}, confidence: 1 } as T;
  },
};

const make = (steps: unknown[], extra: Record<string, unknown> = {}): AgentSpec =>
  ({
    version: "1.1",
    agent: { id: "etl", name: "ETL", role: "R", goal: "G", workflow: steps },
    ...extra,
  }) as unknown as AgentSpec;

async function drive(spec: AgentSpec, input: string, deps: Partial<EngineDeps> = {}) {
  const events: RunEvent[] = [];
  const gen = runWorkflow(spec, { model, env: {}, ...deps }, input);
  let next = await gen.next(undefined);
  while (!next.done) {
    events.push(next.value);
    next = await gen.next(undefined);
  }
  return events;
}
const last = (events: RunEvent[]) => events.at(-1)!;
const output = (events: RunEvent[]) =>
  (last(events) as Extract<RunEvent, { type: "completed" }>).output;
const skippedOf = (events: RunEvent[]) =>
  (last(events) as Extract<RunEvent, { type: "completed" }>).skipped;

describe("transform", () => {
  const steps = (set: Record<string, string>) => [{ step: "shape", type: "transform", set }];

  it("computes percent change, abs, sort, take and join from the trigger", async () => {
    const events = await drive(
      make(
        steps({
          change: "$round((trigger.close - trigger.open) / trigger.open * 100, 2)",
          size: "$abs(trigger.close - trigger.open)",
          top: "$sort(trigger.items, function($a, $b) { $a.n < $b.n })[[0..1]].n",
          label: "$join(trigger.tags, ', ') & ' (' & $string($count(trigger.items)) & ')'",
        }),
      ),
      JSON.stringify({
        open: 80,
        close: 100,
        items: [{ n: 3 }, { n: 9 }, { n: 5 }, { n: 1 }],
        tags: ["a", "b"],
      }),
    );
    expect(output(events).shape).toEqual({
      change: 25,
      size: 20,
      top: [9, 5],
      label: "a, b (4)",
    });
  });

  it("reads earlier steps' outputs and vars", async () => {
    const spec = make(
      [
        { step: "one", type: "transform", set: { base: "vars.k * 2" } },
        { step: "two", type: "transform", set: { plus: "one.base + 1" } },
      ],
      { vars: { k: { type: "number", default: 4 } } },
    );
    expect(output(await drive(spec, "{}")).two).toEqual({ plus: 9 });
  });

  it("fails visibly, naming the step and the value, when an expression selects nothing", async () => {
    const events = await drive(make(steps({ x: "trigger.nope" })), "{}");
    const failed = last(events) as Extract<RunEvent, { type: "failed" }>;
    expect(failed.type).toBe("failed");
    expect(failed.step).toBe("shape");
    expect(failed.error).toMatch(/shape/);
    expect(failed.error).toMatch(/set\.x/);
    expect(failed.error).toMatch(/nothing/);
  });

  it("fails visibly on a run-time expression error", async () => {
    const events = await drive(make(steps({ x: "$number('abc')" })), "{}");
    expect(last(events).type).toBe("failed");
  });

  it("does not let one value read another in the same step", async () => {
    const events = await drive(make(steps({ a: "1", b: "shape.a" })), "{}");
    expect(last(events).type).toBe("failed");
  });
});

describe("validate", () => {
  const spec = (onFail?: string) =>
    make([
      {
        step: "check",
        type: "validate",
        assert: "trigger.close > 0",
        ...(onFail && { on_fail: onFail }),
        message: "close was {{ trigger.close }}",
      },
      { step: "after", type: "transform", set: { ran: "true" } },
    ]);

  it("passes through when the assertion holds", async () => {
    const out = output(await drive(spec(), '{"close": 5}'));
    expect(out.check).toEqual({ passed: true });
    expect(out.after).toEqual({ ran: true });
  });

  it("fails the run with the rendered message by default", async () => {
    const events = await drive(spec(), '{"close": -1}');
    const failed = last(events) as Extract<RunEvent, { type: "failed" }>;
    expect(failed.step).toBe("check");
    expect(failed.error).toMatch(/close was -1/);
    expect(events.some((e) => e.type === "step_started" && e.step === "after")).toBe(false);
  });

  it("on_fail: skip ends the run as completed, records why, and runs nothing after", async () => {
    const events = await drive(spec("skip"), '{"close": -1}');
    const done = last(events) as Extract<RunEvent, { type: "completed" }>;
    expect(done.type).toBe("completed");
    expect(done.skipped).toEqual({ step: "check", reason: "close was -1" });
    expect(done.output.check).toEqual({ passed: false, skipped: true });
    expect(done.output.after).toBeUndefined();
  });

  it("fails when the assertion is not true or false, as a condition does", async () => {
    const events = await drive(
      make([{ step: "check", type: "validate", assert: "trigger.close" }]),
      '{"close": 5}',
    );
    expect(last(events).type).toBe("failed");
  });

  it("fails when the assertion reads something that is missing", async () => {
    const events = await drive(
      make([{ step: "check", type: "validate", assert: "trigger.missing > 0" }]),
      "{}",
    );
    expect(last(events).type).toBe("failed");
  });

  it("says on_fail: branch is not supported if a spec with it reaches the engine", async () => {
    const events = await drive(
      make([{ step: "check", type: "validate", assert: "true", on_fail: "branch" }]),
      "{}",
    );
    const failed = last(events) as Extract<RunEvent, { type: "failed" }>;
    expect(failed.error).toMatch(/branch is not yet supported/);
  });
});

describe("dedupe", () => {
  const spec = (ttl = "1h") =>
    make([
      { step: "seen", type: "dedupe", once: { key: "trigger.id", ttl } },
      { step: "work", type: "transform", set: { done: "true" } },
    ]);

  it("lets the first run through and skips the second with the same key", async () => {
    const store = new SqliteStateStore({ path: ":memory:" });
    const first = await drive(spec(), '{"id": "a1"}', { state: store });
    expect(output(first).seen).toEqual({ duplicate: false, key: "a1" });
    expect(output(first).work).toEqual({ done: true });

    const second = await drive(spec(), '{"id": "a1"}', { state: store });
    const done = last(second) as Extract<RunEvent, { type: "completed" }>;
    expect(done.skipped?.step).toBe("seen");
    expect(done.skipped?.reason).toMatch(/duplicate/);
    expect(done.output.seen).toEqual({ duplicate: true, key: "a1" });
    expect(done.output.work).toBeUndefined();

    const other = await drive(spec(), '{"id": "b2"}', { state: store });
    expect(output(other).work).toEqual({ done: true });
    await store.close();
  });

  it("forgets a key after its ttl", async () => {
    const clock = createFakeClock();
    const store = new SqliteStateStore({ path: ":memory:", clock });
    await drive(spec("1h"), '{"id": "a"}', { state: store });
    clock.advance(30 * 60_000);
    expect(skippedOf(await drive(spec("1h"), '{"id": "a"}', { state: store }))?.step).toBe("seen");
    clock.advance(31 * 60_000);
    expect(output(await drive(spec("1h"), '{"id": "a"}', { state: store })).work).toEqual({
      done: true,
    });
    await store.close();
  });

  it("scopes a key to its workflow and step", async () => {
    const store = new SqliteStateStore({ path: ":memory:" });
    await drive(spec(), '{"id": "a"}', { state: store });
    const otherStep = make([
      { step: "seen2", type: "dedupe", once: { key: "trigger.id", ttl: "1h" } },
    ]);
    expect(skippedOf(await drive(otherStep, '{"id": "a"}', { state: store }))).toBeUndefined();
    expect(skippedOf(await drive(otherStep, '{"id": "a"}', { state: store }))).toBeDefined();
    const otherAgent = make([
      { step: "seen", type: "dedupe", once: { key: "trigger.id", ttl: "1h" } },
    ]);
    (otherAgent.agent as { id: string }).id = "other";
    expect(skippedOf(await drive(otherAgent, '{"id": "a"}', { state: store }))).toBeUndefined();
    await store.close();
  });

  it("survives a restart: a file-backed store, closed and reopened, still knows the key", async () => {
    const path = join(dir, "restart", ".kampong", "state.db");
    const a = new SqliteStateStore({ path });
    const first = await drive(spec("24h"), '{"id": "evt-1"}', { state: a });
    expect(output(first).work).toEqual({ done: true });
    await a.close();

    const b = new SqliteStateStore({ path });
    const second = await drive(spec("24h"), '{"id": "evt-1"}', { state: b });
    expect(skippedOf(second)?.step).toBe("seen");
    await b.close();
  });

  it("accepts a numeric key and refuses a key that selects nothing or is not a scalar", async () => {
    const store = new SqliteStateStore({ path: ":memory:" });
    const numeric = make([{ step: "seen", type: "dedupe", once: { key: "trigger.n", ttl: "1h" } }]);
    expect(output(await drive(numeric, '{"n": 7}', { state: store })).seen).toEqual({
      duplicate: false,
      key: "7",
    });
    for (const body of ["{}", '{"n": [1]}', '{"n": {"a": 1}}']) {
      const events = await drive(numeric, body, { state: store });
      expect(last(events).type, body).toBe("failed");
    }
    await store.close();
  });

  it("fails visibly when there is no state store", async () => {
    const events = await drive(spec(), '{"id": "a"}');
    const failed = last(events) as Extract<RunEvent, { type: "failed" }>;
    expect(failed.step).toBe("seen");
    expect(failed.error).toMatch(/state store/);
  });

  it("opens a store lazily through openState, only for a dedupe step, and closes it after the run", async () => {
    let opened = 0;
    let closed = 0;
    const real = new SqliteStateStore({ path: ":memory:" });
    const openState = async () => {
      opened++;
      return Object.assign(Object.create(real), {
        close: async () => {
          closed++;
        },
      }) as SqliteStateStore;
    };
    await drive(make([{ step: "t", type: "transform", set: { a: "1" } }]), "{}", { openState });
    expect(opened).toBe(0);
    await drive(spec(), '{"id": "z"}', { openState });
    expect(opened).toBe(1);
    expect(closed).toBe(1);
    // A store passed in by the caller is the caller's to close.
    closed = 0;
    await drive(spec(), '{"id": "y"}', { state: real, openState });
    expect(opened).toBe(1);
    expect(closed).toBe(0);
    await real.close();
  });
});

describe("createAgentRun default state store", () => {
  const dedupeSpec = make([
    { step: "seen", type: "dedupe", once: { key: "trigger.id", ttl: "1h" } },
  ]);

  it("creates the sqlite file at statePath only when a dedupe step exists, and dedupes across runs", async () => {
    const path = join(dir, "default", ".kampong", "state.db");
    const plain = createAgentRun(make([{ step: "t", type: "transform", set: { a: "1" } }]), {
      model,
      env: {},
      statePath: path,
    });
    await plain.start("{}");
    expect(existsSync(path)).toBe(false);

    const one = await createAgentRun(dedupeSpec, { model, env: {}, statePath: path }).start(
      '{"id": "q"}',
    );
    expect(one.status).toBe("completed");
    expect(one.skipped).toBeUndefined();
    expect(existsSync(path)).toBe(true);

    const two = await createAgentRun(dedupeSpec, { model, env: {}, statePath: path }).start(
      '{"id": "q"}',
    );
    expect(two.status).toBe("completed");
    expect(two.skipped?.step).toBe("seen");
  });
});
