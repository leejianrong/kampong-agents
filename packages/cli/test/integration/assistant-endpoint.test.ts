import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDevServer } from "../../src/server.js";

// KAM-249 (ADR-0060): the assistant endpoint against a fake OpenAI-compatible server. Replies are recorded text,
// so no network is touched. What matters: nothing is written by asking, an invalid plan is reported and never
// returned as ops, a failed call fails visibly with no other provider tried, and no key is sent in a body.

const KEY = "sk-test-key-not-real";
const SPEC = `version: "1.1"
agent:
  id: a
  name: A
  role: R
  goal: G
  tools:
    - name: fetch_page
      action: http_request
      method: GET
      url: "https://example.test/page"
  workflow:
    - step: get
      type: tool
      tool: fetch_page
`;

const plan = (edits: unknown[], summary = "Adds a summary step.") =>
  JSON.stringify({ summary, edits });
const ADD_SUMMARY = {
  kind: "add_step",
  step: { step: "summarize", action: "summarize_page", query: "Summarize {{ get.body }}" },
};

describe("assistant endpoint", () => {
  let dir: string;
  let app: FastifyInstance | undefined;
  let calls: { url: string; headers: Record<string, string>; body: string }[];
  let replies: (string | Error | number)[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-assistant-"));
    writeFileSync(join(dir, "agent.yaml"), SPEC);
    calls = [];
    replies = [];
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const start = async (env: NodeJS.ProcessEnv) => {
    app = createDevServer({
      specPath: join(dir, "agent.yaml"),
      layoutPath: join(dir, "layout.json"),
      doctor: { env },
      assistantFetch: async (url, init) => {
        calls.push({
          url,
          headers: init.headers as Record<string, string>,
          body: String(init.body),
        });
        const next = replies.shift();
        if (next instanceof Error) throw next;
        if (typeof next === "number") return new Response("nope", { status: next });
        return Response.json({ choices: [{ message: { content: next ?? "" } }] });
      },
    });
    await app.ready();
    return app;
  };
  const OPENROUTER = { OPENROUTER_API_KEY: KEY, KAMPONG_ASSISTANT_MODEL: "vendor/model" };
  const ask = async (prompt = "summarize the page") =>
    app!.inject({ method: "POST", url: "/api/assistant", payload: { prompt } });
  const onDisk = () => readFileSync(join(dir, "agent.yaml"), "utf8");

  it("says where a prompt would go, without a key, and says when it is not set up", async () => {
    await start({});
    const off = (await app!.inject({ method: "GET", url: "/api/assistant" })).json();
    expect(off).toMatchObject({ configured: false, code: "not_configured" });
    await app!.close();

    await start(OPENROUTER);
    const on = (await app!.inject({ method: "GET", url: "/api/assistant" })).json();
    expect(on).toMatchObject({ configured: true, host: "openrouter.ai", model: "vendor/model" });
    expect(JSON.stringify(on)).not.toContain(KEY);
  });

  it("returns a validated plan as ops and writes nothing; the ops then apply as returned", async () => {
    await start(OPENROUTER);
    replies.push(plan([ADD_SUMMARY]));
    const res = await ask();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      success: true,
      mode: "build",
      summary: "Adds a summary step.",
      attempts: 1,
      diff: { added: [{ kind: "step", name: "summarize" }], changed: [], removed: [] },
    });
    expect(body.ops).toEqual([
      { op: "step.insert", place: { in: "workflow" }, step: ADD_SUMMARY.step },
    ]);
    expect(onDisk()).toBe(SPEC);

    // The request carried the workflow and the prompt, and the key only as a header.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body).toContain("fetch_page");
    expect(calls[0]!.body).toContain("summarize the page");
    expect(calls[0]!.body).not.toContain(KEY);

    // Applying through the ordinary write route, with the revision the plan was made against.
    const put = await app!.inject({
      method: "PUT",
      url: "/api/spec",
      payload: { ops: body.ops, baseRevision: body.revision },
    });
    expect(put.statusCode).toBe(200);
    expect(onDisk()).toContain("summarize_page");
    expect(onDisk()).toBe(body.source);
  });

  it("tells the endpoint why a plan did not apply, once, and returns the corrected one", async () => {
    await start(OPENROUTER);
    replies.push(
      plan([{ kind: "add_step", step: { step: "tell", type: "tool", tool: "slack" } }]),
      plan([ADD_SUMMARY]),
    );
    const body = (await ask()).json();
    expect(body).toMatchObject({ success: true, attempts: 2 });
    const second = JSON.parse(calls[1]!.body) as { messages: { role: string; content: string }[] };
    expect(second.messages.at(-1)!.content).toContain(
      'calls the tool "slack", which is not declared',
    );
  });

  it("reports an invalid plan that stays invalid, returns no ops, and leaves the file alone", async () => {
    await start(OPENROUTER);
    replies.push(
      "I cannot do that.",
      plan([{ kind: "replace_step", step: "nope", with: { step: "nope" } }]),
    );
    const res = await ask();
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body).toMatchObject({ success: false, code: "invalid" });
    expect(body.ops).toBeUndefined();
    expect(body.errors.join(" ")).toContain('no step named "nope"');
    expect(onDisk()).toBe(SPEC);
    expect(calls).toHaveLength(2);
  });

  it("fails visibly when the endpoint is down or refuses, with no other provider tried", async () => {
    await start({ ...OPENROUTER, OPENAI_API_KEY: "sk-other" });
    replies.push(new Error(`connect ECONNREFUSED ${KEY}`));
    const down = await ask();
    expect(down.statusCode).toBe(502);
    expect(down.json()).toMatchObject({ success: false, code: "unavailable" });
    expect(down.json().error).toContain("openrouter.ai");
    expect(JSON.stringify(down.json())).not.toContain(KEY);

    replies.push(401);
    const refused = await ask();
    expect(refused.statusCode).toBe(502);
    expect(refused.json().error).toContain("401");
    // Two asks, two calls, both to OpenRouter: nothing fell back to the OpenAI key.
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["openrouter.ai", "openrouter.ai"]);
  });

  it("answers a question in Ask mode with text, never ops, and writes nothing (KAM-251)", async () => {
    await start(OPENROUTER);
    // Even a model that answers with a plan gets it shown as words: ask mode builds no plan.
    replies.push(plan([ADD_SUMMARY]));
    const res = await app!.inject({
      method: "POST",
      url: "/api/assistant",
      payload: { prompt: "what does get do?", mode: "ask" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ success: true, mode: "ask" });
    expect(typeof body.answer).toBe("string");
    expect(body.ops).toBeUndefined();
    expect(body.diff).toBeUndefined();
    expect(onDisk()).toBe(SPEC);
    // What went out is the question and the workflow, under the explaining prompt, not the edit format.
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0]!.body) as { messages: { role: string; content: string }[] };
    expect(sent.messages[0]!.content).toContain("You cannot change the workflow here");
    expect(sent.messages[0]!.content).not.toContain("add_step");
    expect(sent.messages[1]!.content).toContain("what does get do?");
    expect(sent.messages[1]!.content).toContain("fetch_page");
    expect(calls[0]!.body).not.toContain(KEY);
  });

  it("fails visibly in Ask mode too, and refuses an unknown mode", async () => {
    await start(OPENROUTER);
    replies.push(new Error("connect ECONNREFUSED"));
    const down = await app!.inject({
      method: "POST",
      url: "/api/assistant",
      payload: { prompt: "what is this?", mode: "ask" },
    });
    expect(down.statusCode).toBe(502);
    expect(down.json()).toMatchObject({ success: false, code: "unavailable" });
    const bad = await app!.inject({
      method: "POST",
      url: "/api/assistant",
      payload: { prompt: "x", mode: "destroy" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("answers 503 when nothing is set up, and refuses an empty or oversized prompt", async () => {
    await start({});
    const off = await ask();
    expect(off.statusCode).toBe(503);
    expect(off.json()).toMatchObject({ code: "not_configured" });
    expect(calls).toHaveLength(0);
    expect((await ask("   ")).statusCode).toBe(400);
    expect((await ask("x".repeat(4001))).statusCode).toBe(400);
  });

  it("says there is no workflow yet rather than asking the model about nothing", async () => {
    writeFileSync(join(dir, "agent.yaml"), "");
    await start(OPENROUTER);
    const res = await ask();
    expect(res.statusCode).toBe(409);
    expect(calls).toHaveLength(0);
  });
});
