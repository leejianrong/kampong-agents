import { describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import {
  DEDUPE_OPEN_TTL_MS,
  runWorkflow,
  type EngineDeps,
  type RunEvent,
} from "../../src/workflow.js";
import { SqliteStateStore } from "../../src/sqlite-state-store.js";
import type { ModelClient } from "../../src/model.js";
import { createFakeClock } from "./state-store-contract.js";

// KAM-151 (ADR-0041): dedupe is an open/close lifecycle. A claim is open while the run is going, held for
// the ttl once the run succeeds, and released when the run fails, so a retry is not swallowed.

const model: ModelClient = {
  async generateText() {
    return "text";
  },
  async generateStructured<T>() {
    return { result: {}, confidence: 1 } as T;
  },
};

const make = (steps: unknown[]): AgentSpec =>
  ({
    version: "1.1",
    agent: { id: "etl", name: "ETL", role: "R", goal: "G", workflow: steps },
  }) as unknown as AgentSpec;

async function drive(spec: AgentSpec, input: string, deps: Partial<EngineDeps>) {
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
const skipped = (events: RunEvent[]) =>
  (last(events) as Extract<RunEvent, { type: "completed" }>).skipped;

const KEY = "dedupe:etl:seen:a1";
// `trigger.ok` decides whether the step after the dedupe passes.
const spec = make([
  { step: "seen", type: "dedupe", once: { key: "trigger.id", ttl: "1h" } },
  { step: "work", type: "validate", assert: "trigger.ok = true", message: "work failed" },
]);

describe("dedupe open/close lifecycle", () => {
  it("releases the key when a later step fails, so the retry runs", async () => {
    const store = new SqliteStateStore({ path: ":memory:" });
    const failed = await drive(spec, '{"id":"a1","ok":false}', { state: store });
    expect(last(failed).type).toBe("failed");
    expect(await store.exists(KEY)).toBe(false);

    const retry = await drive(spec, '{"id":"a1","ok":true}', { state: store });
    expect(last(retry).type).toBe("completed");
    expect(skipped(retry)).toBeUndefined();
    await store.close();
  });

  it("holds the key for the full ttl once the run succeeds", async () => {
    const clock = createFakeClock();
    const store = new SqliteStateStore({ path: ":memory:", clock });
    await drive(spec, '{"id":"a1","ok":true}', { state: store });
    expect(await store.get(KEY)).toMatchObject({ state: "done" });
    // Well past the short open ttl, inside the 1h ttl: still a duplicate.
    clock.advance(DEDUPE_OPEN_TTL_MS + 60_000);
    const again = await drive(spec, '{"id":"a1","ok":true}', { state: store });
    expect(skipped(again)?.reason).toMatch(/seen within 1h/);
    // And forgotten after it.
    clock.advance(60 * 60_000);
    expect(skipped(await drive(spec, '{"id":"a1","ok":true}', { state: store }))).toBeUndefined();
    await store.close();
  });

  it("says a key is being processed while another run still has it open", async () => {
    const store = new SqliteStateStore({ path: ":memory:" });
    const a = runWorkflow(spec, { model, env: {}, state: store }, '{"id":"a1","ok":true}');
    await a.next(undefined); // step_started: seen
    await a.next(undefined); // step_completed: seen (the claim is open now)
    expect(await store.get(KEY)).toMatchObject({ state: "open" });

    const b = await drive(spec, '{"id":"a1","ok":true}', { state: store });
    expect(skipped(b)?.reason).toMatch(/being processed by another run/);

    for (let next = await a.next(undefined); !next.done; next = await a.next(undefined));
    expect(await store.get(KEY)).toMatchObject({ state: "done" });
    await store.close();
  });

  it("frees an open key after the short open ttl if the process died", async () => {
    const clock = createFakeClock();
    const store = new SqliteStateStore({ path: ":memory:", clock });
    const crashed = runWorkflow(spec, { model, env: {}, state: store }, '{"id":"a1","ok":true}');
    await crashed.next(undefined);
    await crashed.next(undefined); // claimed, then the process "dies": nothing settles it
    expect(skipped(await drive(spec, '{"id":"a1","ok":true}', { state: store }))).toBeDefined();
    clock.advance(DEDUPE_OPEN_TTL_MS + 1000);
    const retry = await drive(spec, '{"id":"a1","ok":true}', { state: store });
    expect(skipped(retry)).toBeUndefined();
    await store.close();
  });

  it("releases an open claim when the run is abandoned part-way", async () => {
    const store = new SqliteStateStore({ path: ":memory:" });
    const run = runWorkflow(spec, { model, env: {}, state: store }, '{"id":"a1","ok":true}');
    await run.next(undefined);
    await run.next(undefined);
    expect(await store.exists(KEY)).toBe(true);
    await run.return(undefined);
    expect(await store.exists(KEY)).toBe(false);
    await store.close();
  });

  it("treats a run that ended as skipped as done, not failed", async () => {
    const store = new SqliteStateStore({ path: ":memory:" });
    const withSkip = make([
      { step: "seen", type: "dedupe", once: { key: "trigger.id", ttl: "1h" } },
      {
        step: "gate",
        type: "validate",
        assert: "false",
        on_fail: "skip",
        message: "nothing to do",
      },
    ]);
    const first = await drive(withSkip, '{"id":"a1"}', { state: store });
    expect(skipped(first)?.step).toBe("gate");
    expect(await store.get(KEY)).toMatchObject({ state: "done" });
    await store.close();
  });

  it("applies the lifecycle per item inside a foreach", async () => {
    const store = new SqliteStateStore({ path: ":memory:" });
    const loop = make([
      {
        step: "each",
        foreach: {
          items: "trigger.ids",
          as: "id",
          on_error: "continue",
          steps: [
            { step: "seen", type: "dedupe", once: { key: "id", ttl: "1h" } },
            { step: "work", type: "validate", assert: 'id != "bad"', message: "bad item" },
          ],
        },
      },
    ]);
    const events = await drive(loop, '{"ids":["good","bad"]}', { state: store });
    expect(last(events).type).toBe("completed");
    expect(await store.get("dedupe:etl:seen:good")).toMatchObject({ state: "done" });
    // The failed item's key is free, so the next run can handle it again.
    expect(await store.exists("dedupe:etl:seen:bad")).toBe(false);
    await store.close();
  });
});
