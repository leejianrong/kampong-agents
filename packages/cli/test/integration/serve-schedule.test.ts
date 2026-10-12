import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient, StateStore } from "@kampong/engine";
import { createServeRuntime } from "../../src/serve-server.js";
import {
  collectServeJobs,
  startServeRunners,
  type ServeRunnersHandle,
} from "../../src/serve-runner.js";

// KAN-1856: a `schedule` trigger under `kampong serve`: the job collected from the spec, and the
// `POST /schedule/run-now` route (404 without a schedule, 409 while a run holds the overlap lock).

const spec = (trigger: string) => `version: "1.1"
agent:
  id: etl
  name: "ETL"
  role: "Analyst"
  goal: "Summarise."
  trigger:
${trigger}
  workflow:
    - step: summarise
      action: write
`;
const SCHEDULE = "    type: schedule\n    every: 1h";
const WEBHOOK = "    type: webhook";

function memoryStore(): StateStore {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => m.get(k) as never,
    put: async (k, v) => void m.set(k, v),
    exists: async (k) => m.has(k),
    delete: async (k) => m.delete(k),
    putIfAbsent: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
    list: async () => [],
    close: async () => {},
  };
}

/** A model whose reply the test releases by hand. */
function gatedModel() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const model: ModelClient = {
    generateText: async () => {
      calls++;
      await gate;
      return "done";
    },
    async generateStructured<T>() {
      return {} as T;
    },
  };
  return { model, release: () => release(), calls: () => calls };
}

describe("kampong serve: schedule trigger", () => {
  let dir: string;
  let app: FastifyInstance | undefined;
  let runners: ServeRunnersHandle | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-serve-schedule-"));
  });
  afterEach(async () => {
    await runners?.stop();
    runners = undefined;
    await app?.close();
    app = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function serve(source: string, model: ModelClient, withRunners = true, log: string[] = []) {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, source);
    const runtime = createServeRuntime({
      specPath,
      getRunners: () => runners,
      run: { createModel: () => model },
    });
    app = runtime.app;
    if (withRunners) {
      runners = startServeRunners(collectServeJobs(runtime.spec, runtime.runManager), {
        openStore: memoryStore,
        log: (l) => log.push(l),
        // The clock never reaches a tick: the scheduled loop just waits, so only run-now runs.
        clock: { now: () => Date.now(), sleep: () => new Promise(() => {}) },
      });
    }
    return runtime;
  }
  const runNow = (a: FastifyInstance) => a.inject({ method: "POST", url: "/schedule/run-now" });

  it("collects one job for a schedule trigger and none otherwise", () => {
    const g = gatedModel();
    const schedule = serve(spec(SCHEDULE), g.model, false);
    expect(collectServeJobs(schedule.spec, schedule.runManager).map((j) => j.name)).toEqual([
      "schedule",
    ]);
    expect(collectServeJobs(schedule.spec)).toEqual([]);
  });

  it("returns 404 when the spec has no schedule trigger", async () => {
    const res = await runNow(serve(spec(WEBHOOK), gatedModel().model).app);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false });
  });

  it("returns 503 when the scheduler is not running", async () => {
    const res = await runNow(serve(spec(SCHEDULE), gatedModel().model, false).app);
    expect(res.statusCode).toBe(503);
  });

  it("starts a run now, answers 201 with its id, and refuses a second with 409 while it runs", async () => {
    const g = gatedModel();
    const { app: server } = serve(spec(SCHEDULE), g.model);

    const first = await runNow(server);
    expect(first.statusCode).toBe(201);
    const { id } = first.json();
    expect(id).toEqual(expect.any(String));

    const second = await runNow(server);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ success: false });
    expect(g.calls()).toBe(1); // the refused request did not start a run

    g.release();
    await waitFor(async () => {
      const state = (await server.inject({ method: "GET", url: `/runs/${id}` })).json().state;
      return state.status === "completed";
    });
    // The lock is released once the run finished, so run-now works again.
    await waitFor(async () => (await runNow(server)).statusCode === 201);
  });

  it("logs a failed run-now instead of dropping it", async () => {
    const log: string[] = [];
    const failing: ModelClient = {
      generateText: async () => {
        throw new Error("model exploded");
      },
      async generateStructured<T>() {
        return {} as T;
      },
    };
    const { app: server } = serve(spec(SCHEDULE), failing, true, log);
    expect((await runNow(server)).statusCode).toBe(201);
    await waitFor(async () =>
      log.some((l) => l.includes("run-now") && l.includes("model exploded")),
    );
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for condition");
}
