import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelClient } from "@kampong/engine";
import { createServeRuntime, type ServeRuntime } from "../../src/serve-server.js";

// KAM-309: a run nobody is watching leaves one readable line when it starts and one when it ends, in words, and
// shows up in GET /runs. Three cases from the audit: an alert accepted (201), a model that is down, and a scheduled
// run whose every item failed (it ended "completed" with nothing logged).

const TEMPLATES = fileURLToPath(new URL("../../templates", import.meta.url));

const okModel: ModelClient = {
  async generateText() {
    return "done";
  },
  async generateStructured<T>() {
    return {} as T;
  },
};
// The raw upstream error: many lines, a request body, a provider's JSON.
const downModel: ModelClient = {
  async generateText() {
    throw new Error(
      `Upstream LLM API error\n${Array.from({ length: 60 }, (_, i) => `  at line ${i}: {"symbols":"AAPL"}`).join("\n")}`,
    );
  },
  async generateStructured<T>(): Promise<T> {
    throw new Error("Upstream LLM API error\n  at line 1");
  },
};

const WEBHOOK_SPEC = (step: string) => `version: "1.1"
agent:
  id: hook
  name: "Hook"
  role: "R"
  goal: "G"
  model:
    provider: ollama
    name: m
  trigger:
    type: webhook
  workflow:
${step}`;

describe("kampong serve run log", () => {
  let dir: string;
  let lines: string[];
  let runtime: ServeRuntime | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-serve-runlog-"));
    lines = [];
  });
  afterEach(async () => {
    await runtime?.app.close();
    runtime = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const serve = (source: string, model: ModelClient, env: NodeJS.ProcessEnv = {}) => {
    writeFileSync(join(dir, "agent.yaml"), source);
    runtime = createServeRuntime({
      specPath: join(dir, "agent.yaml"),
      run: { createModel: () => model, env, log: (l) => lines.push(l) },
    });
    return runtime;
  };
  const settled = async (r: ServeRuntime, id: string) => (await r.runManager.settle(id, 10_000))!;

  it("an accepted alert logs its start and its outcome, and is listed", async () => {
    const r = serve(
      WEBHOOK_SPEC("    - step: shape\n      type: transform\n      set:\n        v: '1'\n"),
      okModel,
    );
    const res = await r.app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ alert: 1 }),
    });
    expect(res.statusCode).toBe(201);
    await settled(r, res.json().id);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ run [0-9a-f]{8} started \(webhook\)$/,
    );
    expect(lines[1]).toMatch(/run [0-9a-f]{8} \(webhook\) completed, 1 step$/);

    const list = (await r.app.inject({ method: "GET", url: "/runs" })).json();
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]).toMatchObject({
      id: res.json().id,
      trigger: "webhook",
      status: "completed",
      outcome: "completed, 1 step",
    });
    expect(list.runs[0].endedAt).toBeDefined();
    const one = (await r.app.inject({ method: "GET", url: `/runs/${res.json().id}` })).json();
    expect(one.outcome).toBe("completed, 1 step");
  });

  it("a model that is down leaves one short line, not the whole upstream error", async () => {
    const r = serve(WEBHOOK_SPEC("    - step: think\n      action: say_hello\n"), downModel);
    const res = await r.app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ alert: 1 }),
    });
    await settled(r, res.json().id);

    const end = lines.at(-1)!;
    expect(end).toMatch(/\(webhook\) failed: Upstream LLM API error$/);
    expect(end).not.toContain("\n");
    expect(end.length).toBeLessThan(300);
    expect(lines.join("\n")).not.toContain("at line 5");

    const list = (await r.app.inject({ method: "GET", url: "/runs" })).json();
    expect(list.runs[0]).toMatchObject({ status: "failed" });
    expect(list.runs[0].outcome).toMatch(/^failed: Upstream LLM API error$/);
  });

  it("lists runs newest first", async () => {
    const r = serve(
      WEBHOOK_SPEC("    - step: shape\n      type: transform\n      set:\n        v: '1'\n"),
      okModel,
    );
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await r.app.inject({
        method: "POST",
        url: "/webhook",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ n: i }),
      });
      ids.push(res.json().id);
      await settled(r, res.json().id);
    }
    const list = (await r.app.inject({ method: "GET", url: "/runs" })).json();
    expect(list.runs.map((x: { id: string }) => x.id)).toEqual([...ids].reverse());
  });

  it("a scheduled market-etl run with no credentials says nothing worked, not 'completed'", async () => {
    cpSync(join(TEMPLATES, "market-etl"), dir, { recursive: true });
    runtime = createServeRuntime({
      specPath: join(dir, "agent.yaml"),
      run: { createModel: () => okModel, env: {}, log: (l) => lines.push(l) },
    });
    const { id } = await runtime.runManager.start(runtime.spec, "");
    await settled(runtime, id);

    expect(lines.at(-1)).toMatch(/\(schedule\) finished, but nothing worked: every item failed/);
    expect(lines.at(-1)).toMatch(/First: each_symbol\[0\]\.fetch:/);
    expect(lines.at(-1)).not.toContain("\n");
    const list = (await runtime.app.inject({ method: "GET", url: "/runs" })).json();
    expect(list.runs[0].trigger).toBe("schedule");
    expect(list.runs[0].outcome).toContain("nothing worked");
  }, 30_000);
});
