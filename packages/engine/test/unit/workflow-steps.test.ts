import { describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { runWorkflow, type ApprovalDecision, type RunEvent } from "../../src/workflow.js";
import type { ModelClient } from "../../src/model.js";

// KAN-1429 (ADR-0021): first-class tool steps and approval steps, plus
// `{{ step.field }}` / `{{ input }}` data references. Driven deterministically
// with a fake ModelClient and a canned fetch -- no network, same pattern as the
// sibling workflow.test.ts / guardrail.test.ts suites.

function structuredModel(
  byStep: Record<string, Record<string, unknown>>,
  capturedPrompts?: string[],
): ModelClient {
  return {
    async generateText({ prompt }: { prompt: string }) {
      capturedPrompts?.push(prompt);
      return "drafted text";
    },
    async generateStructured<T>({ prompt }: { prompt: string }) {
      const stepName = /Step: (\S+)/.exec(prompt)?.[1] ?? "";
      return { result: byStep[stepName] ?? {}, confidence: 1 } as T;
    },
  };
}

async function drive(
  spec: AgentSpec,
  deps: { model: ModelClient; fetchImpl?: typeof fetch },
  input: string,
  decide: (ev: Extract<RunEvent, { type: "awaiting_approval" }>) => ApprovalDecision = () => ({
    approved: true,
  }),
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const gen = runWorkflow(spec, deps, input);
  let next = await gen.next(undefined);
  while (!next.done) {
    const ev = next.value;
    events.push(ev);
    const decision = ev.type === "awaiting_approval" ? decide(ev) : undefined;
    next = await gen.next(decision);
  }
  return events;
}

function baseAgent(partial: Partial<AgentSpec["agent"]>): AgentSpec {
  return {
    version: "1.0",
    agent: {
      id: "a",
      name: "A",
      role: "Tester",
      goal: "Test the new step kinds.",
      ...partial,
    } as AgentSpec["agent"],
  };
}

describe("tool step (KAN-1429)", () => {
  it("runs a named tool as a normal step and resolves {{ step.field }} in the URL", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ order: { status: "shipped" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const spec = baseAgent({
      tools: [
        {
          name: "get_order",
          action: "http_request",
          method: "GET",
          url: "https://api.example.com/orders/{{ classify.order_id }}",
          extract: "order",
        },
      ],
      workflow: [
        { step: "classify", action: "classify", confidence_gate: true },
        { step: "lookup", type: "tool", tool: "get_order" },
      ],
    });

    const events = await drive(
      spec,
      { model: structuredModel({ classify: { order_id: "42" } }), fetchImpl },
      "where is my order",
    );

    expect(urls).toEqual(["https://api.example.com/orders/42"]);
    const lookup = events.find((e) => e.type === "step_completed" && e.step === "lookup");
    expect(lookup).toMatchObject({ output: { status: "shipped" } });
    expect(events.at(-1)).toMatchObject({ type: "completed" });
  });

  it("fails the run when a tool step references an unknown tool", async () => {
    const spec = baseAgent({
      workflow: [{ step: "lookup", type: "tool", tool: "missing" }],
    });
    const events = await drive(spec, { model: structuredModel({}) }, "hi");
    expect(events.at(-1)).toMatchObject({ type: "failed", step: "lookup" });
    expect((events.at(-1) as { error: string }).error).toMatch(/unknown tool "missing"/);
  });

  it("honors a tool step's requires_approval before calling it", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const spec = baseAgent({
      tools: [
        {
          name: "send",
          action: "http_request",
          method: "POST",
          url: "https://api.example.com/send",
          requires_approval: true,
        },
      ],
      workflow: [{ step: "act", type: "tool", tool: "send" }],
    });

    const events = await drive(spec, { model: structuredModel({}), fetchImpl }, "go");
    const pause = events.find((e) => e.type === "awaiting_approval");
    expect(pause).toMatchObject({ kind: "tool", toolName: "send" });
    expect(events.at(-1)).toMatchObject({ type: "completed" });
  });
});

describe("approval step (KAN-1429)", () => {
  it("pauses with kind 'approval', resolves {{ input }} in the message, and completes on approve", async () => {
    const spec = baseAgent({
      workflow: [{ step: "review", type: "approval", message: "Approve reply to {{ input }}?" }],
    });
    const events = await drive(spec, { model: structuredModel({}) }, "ticket #7");
    const pause = events.find((e) => e.type === "awaiting_approval");
    expect(pause).toMatchObject({ kind: "approval", reason: "Approve reply to ticket #7?" });
    expect(events.at(-1)).toMatchObject({ type: "completed" });
  });

  it("stops the run as rejected when the approval is denied", async () => {
    const spec = baseAgent({
      workflow: [{ step: "review", type: "approval" }],
    });
    const events = await drive(spec, { model: structuredModel({}) }, "x", () => ({
      approved: false,
      reason: "not ok",
    }));
    expect(events.some((e) => e.type === "completed")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "rejected", step: "review", reason: "not ok" });
  });
});

describe("support-triage hero end to end (KAN-1429 acceptance)", () => {
  it("classify -> tool lookup -> draft -> approval -> tool send completes on approve", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/orders/")) {
        return new Response(JSON.stringify({ order: { status: "shipped" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: { sent: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    const spec = baseAgent({
      id: "support_triage",
      name: "Support Triage",
      role: "Front-line support agent",
      goal: "Triage a support message and draft a reply.",
      tools: [
        {
          name: "get_order",
          action: "http_request",
          method: "GET",
          url: "https://api.shop.example/orders/{{ classify.order_id }}",
          extract: "order",
        },
        {
          name: "send_reply",
          action: "http_request",
          method: "POST",
          url: "https://api.helpdesk.example/reply",
          extract: "result",
        },
      ],
      workflow: [
        { step: "classify", action: "classify", confidence_gate: true },
        { step: "lookup", type: "tool", tool: "get_order" },
        {
          step: "draft",
          action: "generate_text",
          query: "Draft a {{ classify.category }} reply.",
        },
        { step: "review", type: "approval", message: "Approve this reply?" },
        { step: "send", type: "tool", tool: "send_reply" },
      ],
    });

    const events = await drive(
      spec,
      { model: structuredModel({ classify: { category: "refund", order_id: "42" } }), fetchImpl },
      "Where is my refund for order 42?",
    );

    // The lookup resolved the order id into the URL, and the run reached send.
    expect(calls).toEqual([
      "https://api.shop.example/orders/42",
      "https://api.helpdesk.example/reply",
    ]);
    const final = events.at(-1);
    expect(final).toMatchObject({ type: "completed" });
    expect((final as { output: Record<string, unknown> }).output).toMatchObject({
      lookup: { status: "shipped" },
      review: { approved: true },
      send: { sent: true },
    });
  });
});

describe("data references in an action step query (KAN-1429)", () => {
  it("substitutes {{ step.field }} into the model prompt", async () => {
    const prompts: string[] = [];
    const spec = baseAgent({
      workflow: [
        { step: "classify", action: "classify", confidence_gate: true },
        {
          step: "draft",
          action: "generate_text",
          query: "Reply to a {{ classify.category }} request.",
        },
      ],
    });
    await drive(
      spec,
      { model: structuredModel({ classify: { category: "refund" } }, prompts) },
      "hi",
    );
    expect(prompts.some((p) => p.includes("Reply to a refund request."))).toBe(true);
  });
});

// KAN-1843 (ADR-0038): output_schema, validate-and-retry, confidence as an ordinary field.
describe("output_schema (KAN-1843)", () => {
  const schema = {
    type: "object" as const,
    required: ["severity", "confidence"],
    properties: {
      severity: { type: "string" as const, enum: ["low", "high"] },
      confidence: { type: "number" as const },
      tags: { type: "array" as const, items: { type: "string" as const } },
    },
  };
  const spec = (over: Record<string, unknown> = {}): AgentSpec =>
    ({
      version: "1.1",
      agent: {
        id: "a",
        name: "A",
        role: "R",
        goal: "G",
        guardrails: { confidence_threshold: 0.8, fallback_action: "escalate_to_human" },
        workflow: [
          { step: "triage", action: "classify", output_schema: schema, ...over },
          {
            step: "route",
            type: "condition",
            if: "triage.severity = 'high' and triage.confidence >= 0.5",
            then: "request_human_approval",
            else: "execute_tool(notify)",
          },
        ],
        tools: [{ name: "notify", action: "http_request", method: "GET", url: "https://x.test/" }],
      },
    }) as AgentSpec;

  const scripted = (answers: unknown[], prompts: string[] = []): ModelClient => {
    let i = 0;
    return {
      async generateText() {
        return "";
      },
      async generateStructured<T>({ prompt }: { prompt: string }) {
        prompts.push(prompt);
        return answers[Math.min(i++, answers.length - 1)] as T;
      },
    };
  };

  it("stores the validated object as the step output, so later steps can read its fields", async () => {
    const events = await drive(
      spec(),
      { model: scripted([{ severity: "high", confidence: 0.9 }]) },
      "x",
    );
    const done = events.find((e) => e.type === "step_completed" && e.step === "triage");
    expect(done).toMatchObject({ output: { severity: "high", confidence: 0.9 } });
    expect(events.some((e) => e.type === "awaiting_approval" && e.step === "route")).toBe(true);
    // The other branch is taken when the typed field says so.
    const low = await drive(
      spec(),
      {
        model: scripted([{ severity: "low", confidence: 0.9 }]),
        fetchImpl: async () => new Response("{}"),
      },
      "x",
    );
    expect(low.some((e) => e.type === "awaiting_approval" && e.step === "route")).toBe(false);
    expect(low.at(-1)).toMatchObject({ type: "completed" });
  });

  it("hands the provider the step's structure, not an open object", async () => {
    let seen: unknown;
    const model: ModelClient = {
      async generateText() {
        return "";
      },
      async generateStructured<T>({ schema }: { schema: unknown }) {
        seen = schema;
        return { severity: "low", confidence: 1 } as T;
      },
    };
    await drive(spec(), { model }, "x");
    const json = JSON.stringify((await import("zod")).z.toJSONSchema(seen as never));
    expect(json).toContain('"severity"');
    expect(json).not.toContain("propertyNames");
  });

  it("sends the schema in the prompt", async () => {
    const prompts: string[] = [];
    await drive(spec(), { model: scripted([{ severity: "low", confidence: 1 }], prompts) }, "x");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"enum"');
    expect(prompts[0]).not.toContain("{ result:");
  });

  it("retries once with the problems named, then continues", async () => {
    const prompts: string[] = [];
    const events = await drive(
      spec(),
      {
        model: scripted(
          [
            { severity: "medium", confidence: 0.9 },
            { severity: "low", confidence: 0.9 },
          ],
          prompts,
        ),
      },
      "x",
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("output.severity must be one of low, high");
    expect(events.find((e) => e.type === "step_completed" && e.step === "triage")).toMatchObject({
      output: { severity: "low" },
    });
  });

  it("fails visibly after one retry, never a third call", async () => {
    const prompts: string[] = [];
    const events = await drive(
      spec(),
      { model: scripted([{ severity: "medium", confidence: "?" }], prompts) },
      "x",
    );
    expect(prompts).toHaveLength(2);
    const failed = events.at(-1);
    expect(failed).toMatchObject({ type: "failed", step: "triage" });
    expect((failed as { error: string }).error).toMatch(
      /did not match output_schema after 1 retry/,
    );
    expect((failed as { error: string }).error).toContain("output.confidence must be a number");
  });

  it("does not retry a model call that throws", async () => {
    let calls = 0;
    const model: ModelClient = {
      async generateText() {
        return "";
      },
      async generateStructured() {
        calls++;
        throw new Error("model unavailable");
      },
    };
    const events = await drive(spec(), { model }, "x");
    expect(calls).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      error: expect.stringContaining("unavailable"),
    });
  });

  it("fills a declared default before validating", async () => {
    const withDefault = spec({
      output_schema: {
        ...schema,
        properties: { ...schema.properties, region: { type: "string", default: "eu" } },
        required: ["severity", "confidence", "region"],
      },
    });
    const events = await drive(
      withDefault,
      { model: scripted([{ severity: "low", confidence: 1 }]) },
      "x",
    );
    expect(events.find((e) => e.type === "step_completed" && e.step === "triage")).toMatchObject({
      output: { region: "eu" },
    });
  });

  describe("confidence_gate reads the ordinary confidence field", () => {
    it("escalates below the threshold, and reports the confidence on the event", async () => {
      const events = await drive(
        spec({ confidence_gate: true }),
        { model: scripted([{ severity: "high", confidence: 0.2 }]) },
        "x",
      );
      expect(events.find((e) => e.type === "step_completed" && e.step === "triage")).toMatchObject({
        confidence: 0.2,
      });
      expect(events.find((e) => e.type === "awaiting_approval")).toMatchObject({
        step: "triage",
        kind: "guardrail",
      });
    });

    it("passes at or above the threshold", async () => {
      const events = await drive(
        spec({ confidence_gate: true }),
        { model: scripted([{ severity: "high", confidence: 0.8 }]) },
        "x",
      );
      expect(events.find((e) => e.type === "awaiting_approval")).toMatchObject({ step: "route" });
    });

    it("a missing confidence is a schema failure, never full confidence", async () => {
      const prompts: string[] = [];
      const optional = spec({
        confidence_gate: true,
        output_schema: { ...schema, required: ["severity"] },
      });
      const events = await drive(
        optional,
        { model: scripted([{ severity: "high" }], prompts) },
        "x",
      );
      expect(prompts).toHaveLength(2);
      expect(events.at(-1)).toMatchObject({ type: "failed", step: "triage" });
    });

    it("treats a confidence outside 0 to 1 as a schema failure and retries", async () => {
      const prompts: string[] = [];
      await drive(
        spec({ confidence_gate: true }),
        {
          model: scripted(
            [
              { severity: "high", confidence: 7 },
              { severity: "high", confidence: 0.9 },
            ],
            prompts,
          ),
        },
        "x",
      );
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("between 0 and 1");
    });
  });

  it("a 1.1 gate step without a schema exposes confidence as a field too; 1.0 is unchanged", async () => {
    const legacy = (version: string): AgentSpec =>
      ({
        version,
        agent: {
          id: "a",
          name: "A",
          role: "R",
          goal: "G",
          guardrails: { confidence_threshold: 0.1, fallback_action: "escalate_to_human" },
          workflow: [{ step: "triage", action: "classify", confidence_gate: true }],
        },
      }) as AgentSpec;
    const model = {
      async generateText() {
        return "";
      },
      async generateStructured<T>() {
        return { result: { severity: "low" }, confidence: 0.9 } as T;
      },
    } satisfies ModelClient;
    const out = async (v: string) =>
      (await drive(legacy(v), { model }, "x")).find((e) => e.type === "step_completed") as {
        output: unknown;
      };
    expect((await out("1.1")).output).toEqual({ severity: "low", confidence: 0.9 });
    expect((await out("1.0")).output).toEqual({ severity: "low" });
  });
});
