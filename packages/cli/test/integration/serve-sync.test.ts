import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@kampong/engine";
import { createServeServer } from "../../src/serve-server.js";

// KAM-109: `trigger.respond: sync` answers the webhook POST with the final output.

const spec = (extraSteps = "", trigger = "respond: sync") => `version: "1.1"
agent:
  id: qa
  name: "QA"
  role: "Analyst"
  goal: "Answer a question."
  trigger:
    type: webhook
    ${trigger}
  workflow:
    - step: answer
      action: answer_question
      query: "{{ trigger.question }}"
${extraSteps}`;

const APPROVAL = `    - step: review
      type: approval
      message: "Send it?"
`;

const model = (text: () => Promise<string>): ModelClient => ({
  generateText: text,
  async generateStructured<T>() {
    return {} as T;
  },
});

describe("kampong serve — respond: sync", () => {
  let dir: string;
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-serve-sync-"));
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function serve(source: string, text: () => Promise<string>) {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, source);
    app = createServeServer({ specPath, run: { createModel: () => model(text) } });
    return app;
  }
  const post = (a: FastifyInstance) =>
    a.inject({ method: "POST", url: "/webhook", payload: { question: "why?" } });

  it("answers with the final output, status 200, once the run completes", async () => {
    const res = await post(serve(spec(), async () => "because"));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.id).toEqual(expect.any(String));
    expect(JSON.stringify(body.output)).toContain("because");
    expect(body.state.status).toBe("completed");
  });

  it("answers 500 with the error when the run fails", async () => {
    const res = await post(
      serve(spec(), async () => {
        throw new Error("model exploded");
      }),
    );
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ success: false, id: expect.any(String) });
    expect(res.json().error).toContain("model exploded");
  });

  it("answers 202 with the run id when the run pauses for approval, and the run is still there to approve", async () => {
    const a = serve(spec(APPROVAL), async () => "draft");
    const res = await post(a);
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ success: true, pending: "approval" });
    expect(body.state.status).toBe("awaiting_approval");
    const done = await a.inject({
      method: "POST",
      url: `/runs/${body.id}/approve`,
      payload: { approved: true },
    });
    expect(done.statusCode).toBe(200);
  });

  it("answers 202 with the run id when the timeout passes first, and the run carries on", async () => {
    let release: (text: string) => void = () => {};
    const slow = new Promise<string>((resolve) => (release = resolve));
    const a = serve(spec("", "respond: sync\n    timeout_ms: 1000"), () => slow);
    const res = await post(a);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ success: true, pending: "timeout" });
    release("late");
    const id = res.json().id as string;
    for (let i = 0; i < 80; i++) {
      const state = (await a.inject({ method: "GET", url: `/runs/${id}` })).json().state;
      if (state.status === "completed") return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the run did not finish after the caller was answered");
  });

  it("leaves a trigger without respond: sync answering with a run id, as before", async () => {
    const res = await post(serve(spec("", "respond: async"), async () => "x"));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ success: true, id: expect.any(String) });
    expect(res.json().output).toBeUndefined();
  });
});
