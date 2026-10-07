import { describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { createMastraModelClient } from "../../src/model.js";
import { runWorkflow, type RunEvent } from "../../src/workflow.js";

// KAN-1843 (ADR-0038), found by review: the provider is given the step's real structure, and Mastra's
// default is to THROW when the answer breaks it (a wrong enum value, a wrong type, a missing field). That
// must reach the engine's one retry as a located problem, not fail the step on the first answer. The fake
// ModelClient the unit tests use cannot show this, so this goes through the real Mastra agent with a
// canned HTTP response in place of the network.

const spec = {
  version: "1.1",
  agent: {
    id: "a",
    name: "A",
    role: "R",
    goal: "G",
    model: { provider: "ollama", name: "m", base_url: "http://model.invalid" },
    workflow: [
      {
        step: "triage",
        action: "classify",
        output_schema: {
          type: "object",
          required: ["severity"],
          properties: {
            severity: { type: "string", enum: ["low", "high"] },
            count: { type: "integer" },
          },
        },
      },
    ],
  },
} as AgentSpec;

function cannedModel(answers: unknown[]) {
  const prompts: string[] = [];
  let calls = 0;
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: { content: string }[] };
    prompts.push(JSON.stringify(body.messages));
    const answer = answers[Math.min(calls++, answers.length - 1)];
    return new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 1,
        model: "m",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify(answer) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { client: createMastraModelClient(spec, {}, { fetchImpl }), prompts, calls: () => calls };
}

async function run(model: ReturnType<typeof createMastraModelClient>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const gen = runWorkflow(spec, { model }, "x");
  let next = await gen.next(undefined);
  while (!next.done) {
    events.push(next.value);
    next = await gen.next(undefined);
  }
  return events;
}

describe("output_schema through the real Mastra agent", () => {
  it("a valid answer passes", async () => {
    const m = cannedModel([{ severity: "low" }]);
    const events = await run(m.client);
    expect(events.at(-1)).toMatchObject({ type: "completed" });
    expect(m.calls()).toBe(1);
  });

  for (const [label, bad] of [
    ["a wrong enum value", { severity: "mid" }],
    ["a wrong type", { severity: "low", count: 1.5 }],
    ["a missing required field", { count: 1 }],
  ] as const) {
    it(`${label} is retried once with the problem named, then accepted`, async () => {
      const m = cannedModel([bad, { severity: "high" }]);
      const events = await run(m.client);
      expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({ type: "completed" });
      expect(m.calls()).toBe(2);
      expect(m.prompts[1]).toContain("Your previous answer was rejected");
      expect(m.prompts[1]).toContain("output.");
    });
  }

  it("names every problem in one answer, each located", async () => {
    const m = cannedModel([{ severity: "mid", count: 1.5 }, { severity: "low" }]);
    await run(m.client);
    expect(m.prompts[1]).toContain("output.severity");
    expect(m.prompts[1]).toContain("output.count");
  });

  it("fails visibly with a located problem when the retry is wrong too, never a third call", async () => {
    const m = cannedModel([{ severity: "mid" }]);
    const events = await run(m.client);
    expect(m.calls()).toBe(2);
    const failed = events.at(-1) as { type: string; error: string };
    expect(failed.type).toBe("failed");
    expect(failed.error).toMatch(/did not match output_schema after 1 retry: .*output\.severity/);
  });
});
