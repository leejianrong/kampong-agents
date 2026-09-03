import { describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { runWorkflow, type RunEvent } from "../../src/workflow.js";
import type { ModelClient } from "../../src/model.js";

// Two regression cases from a code-review pass on SLICES.md V2:
//
// 1. buildToolParams used to flatten every prior step's output fields into
//    one unnamespaced bag, so two steps that happen to share a field name
//    (or a field literally named `input`) would silently clobber each other
//    before URL substitution. Params are now namespaced under the
//    producing step's name (`{step_name.field}`).
// 2. A condition step's `then`/`else` value that isn't exactly
//    `execute_tool(name)` or `request_human_approval` used to fall through
//    to a silent no-op ("record { branch } and carry on"). That contradicts
//    this project's fail-visibly convention (AGENTS.md, ADR-0004); it must
//    now fail the run instead.

function fakeModel(results: Record<string, unknown>): ModelClient {
  return {
    async generateText() {
      return "unused in this test";
    },
    async generateStructured<T>({ prompt }: { prompt: string }) {
      const stepNameMatch = /Step: (\S+)/.exec(prompt);
      const stepName = stepNameMatch?.[1] ?? "";
      return { result: results[stepName], confidence: 1 } as T;
    },
  };
}

async function drive(
  spec: AgentSpec,
  deps: { model: ModelClient; fetchImpl?: typeof fetch },
  input: string,
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const generator = runWorkflow(spec, deps, input);
  let next = await generator.next(undefined);
  while (!next.done) {
    events.push(next.value);
    next = await generator.next({ approved: true });
  }
  return events;
}

describe("buildToolParams namespacing (regression)", () => {
  it("keeps two prior steps' same-named field distinct instead of clobbering", async () => {
    const capturedUrls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      capturedUrls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const spec: AgentSpec = {
      version: "1.0",
      agent: {
        id: "namespacing-agent",
        name: "Namespacing Agent",
        role: "Tester",
        goal: "Prove step outputs don't clobber each other.",
        tools: [
          {
            name: "report",
            action: "http_request",
            method: "GET",
            url: "https://api.example.com/report?a={step_a.status}&b={step_b.status}&in={input}",
          },
        ],
        workflow: [
          { step: "step_a", action: "produce", confidence_gate: true },
          { step: "step_b", action: "produce", confidence_gate: true },
          {
            step: "report_step",
            type: "condition",
            if: 'step_a.status == "from_a"',
            then: "execute_tool(report)",
            else: "request_human_approval",
          },
        ],
      },
    };

    const model = fakeModel({ step_a: { status: "from_a" }, step_b: { status: "from_b" } });
    const events = await drive(spec, { model, fetchImpl }, "the-original-input");

    expect(events.some((e) => e.type === "failed")).toBe(false);
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toBe(
      "https://api.example.com/report?a=from_a&b=from_b&in=the-original-input",
    );
  });
});

describe("unrecognized condition-branch action (regression)", () => {
  it("fails the run instead of silently recording an opaque annotation", async () => {
    const spec: AgentSpec = {
      version: "1.0",
      agent: {
        id: "bad-branch-agent",
        name: "Bad Branch Agent",
        role: "Tester",
        goal: "Prove an unsupported branch action fails loudly.",
        workflow: [
          { step: "parse", action: "produce", confidence_gate: true },
          {
            step: "decide",
            type: "condition",
            if: "parse.go == true",
            then: "do_something_unsupported",
            else: "request_human_approval",
          },
        ],
      },
    };

    const model = fakeModel({ parse: { go: true } });
    const events = await drive(spec, { model }, "input");

    const failed = events.find((e) => e.type === "failed");
    expect(failed).toBeDefined();
    expect(failed).toMatchObject({
      type: "failed",
      step: "decide",
      error: expect.stringContaining('"do_something_unsupported"'),
    });
    expect(events.some((e) => e.type === "completed")).toBe(false);
  });
});
