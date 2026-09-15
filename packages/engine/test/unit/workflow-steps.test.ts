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
