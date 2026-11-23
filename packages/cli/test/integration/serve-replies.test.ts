import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelClient } from "@kampong/engine";
import { createServeRuntime, type ServeRuntime } from "../../src/serve-server.js";

// KAM-316: what a sender reads back from `kampong serve`. The audit found jargon ("when predicate was false"), the
// JSON parser's own text, a 201 with an id but no URL, and `success: true` around a run that failed.

const SPEC = (extra = "") => `version: "1.1"
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
    when: 'trigger.status = "firing"'
  workflow:
    - step: ${extra || "shape\n      type: transform\n      set:\n        v: '1'"}
`;

const failingModel: ModelClient = {
  async generateText() {
    throw new Error("Upstream is down");
  },
  async generateStructured<T>(): Promise<T> {
    throw new Error("Upstream is down");
  },
};

describe("kampong serve: replies a sender can read", () => {
  let dir: string;
  let runtime: ServeRuntime | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-serve-replies-"));
  });
  afterEach(async () => {
    await runtime?.app.close();
    runtime = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const serve = (source: string, model?: ModelClient) => {
    writeFileSync(join(dir, "agent.yaml"), source);
    runtime = createServeRuntime({
      specPath: join(dir, "agent.yaml"),
      run: { createModel: () => model ?? failingModel, env: {} },
    });
    return runtime;
  };
  const post = (r: ServeRuntime, payload: string, type = "application/json") =>
    r.app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": type, host: "alerts.example.com:8080" },
      payload,
    });

  it("a request that fails the rule is ignored with the rule in the reason", async () => {
    const r = serve(SPEC());
    const res = await post(r, JSON.stringify({ status: "resolved" }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      ignored: true,
      reason: 'the request did not meet the trigger\'s rule `trigger.status = "firing"`',
    });
  });

  it("an empty body says it had no content", async () => {
    const r = serve(SPEC());
    const res = await post(r, "", "text/plain");
    expect(res.json().reason).toMatch(/^the request had no content/);
  });

  it("malformed JSON is named in a sentence, in the same envelope", async () => {
    const r = serve(SPEC());
    const res = await post(r, "{ not json");
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/^The request body is not valid JSON, so no run started\./);
    expect(body.error).not.toMatch(/Expected property name|Unexpected token/);
  });

  it("a JSON content type with no body says so", async () => {
    const r = serve(SPEC());
    const res = await post(r, "");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no body, so no run started/);
  });

  it("the 201 carries the run's URL, built from the address the sender used", async () => {
    const r = serve(SPEC());
    const res = await post(r, JSON.stringify({ status: "firing" }));
    expect(res.statusCode).toBe(201);
    expect(res.json().url).toBe(`http://alerts.example.com:8080/runs/${res.json().id}`);
  });

  it("success is false for a run that failed", async () => {
    const r = serve(SPEC("think\n      action: say_hello"));
    const res = await post(r, JSON.stringify({ status: "firing" }));
    await r.runManager.settle(res.json().id, 10_000);
    const run = (await r.app.inject({ method: "GET", url: `/runs/${res.json().id}` })).json();
    expect(run.state.status).toBe("failed");
    expect(run.success).toBe(false);
    expect(run.outcome).toMatch(/^failed: /);
  });

  it("success stays true for a run that worked", async () => {
    const r = serve(SPEC());
    const res = await post(r, JSON.stringify({ status: "firing" }));
    await r.runManager.settle(res.json().id, 10_000);
    const run = (await r.app.inject({ method: "GET", url: `/runs/${res.json().id}` })).json();
    expect(run.success).toBe(true);
  });
});
