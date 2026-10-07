import { describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import {
  runWorkflow,
  type ApprovalDecision,
  type ComponentDispatcher,
  type EngineDeps,
  type RunEvent,
} from "../../src/workflow.js";
import type { ModelClient } from "../../src/model.js";

// KAN-1841: a version 1.1 spec runs: conditions and {{ }} are expressions over the trigger, vars, the raw
// input and every earlier step's full output. Deterministic: a fake model and a canned fetch.

const prompts: string[] = [];
const model: ModelClient = {
  async generateText({ prompt }: { prompt: string }) {
    prompts.push(prompt);
    return "drafted";
  },
  async generateStructured<T>() {
    return { result: {}, confidence: 1 } as T;
  },
};

async function drive(
  spec: AgentSpec,
  input: string,
  deps: Partial<EngineDeps> = {},
  decide: (ev: Extract<RunEvent, { type: "awaiting_approval" }>) => ApprovalDecision = () => ({
    approved: true,
  }),
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const gen = runWorkflow(spec, { model, env: {}, ...deps }, input);
  let next = await gen.next(undefined);
  while (!next.done) {
    const ev = next.value;
    events.push(ev);
    next = await gen.next(ev.type === "awaiting_approval" ? decide(ev) : undefined);
  }
  return events;
}

const make = (partial: Record<string, unknown>, vars?: Record<string, unknown>): AgentSpec =>
  ({
    version: "1.1",
    ...(vars && { vars }),
    agent: { id: "a", name: "A", role: "R", goal: "G", ...partial },
  }) as unknown as AgentSpec;

const fetchOf = (log: string[], body: unknown = { items: [{ name: "x" }, { name: "y" }] }) =>
  (async (url: string | URL) => {
    log.push(String(url));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

const last = (events: RunEvent[]) => events.at(-1)!;
const failed = (events: RunEvent[]) =>
  events.find((e) => e.type === "failed") as Extract<RunEvent, { type: "failed" }> | undefined;

const ALERT = JSON.stringify({
  alerts: [{ id: "A1", labels: { alertname: "HighCPU" } }],
  change: -7,
  tags: ["a", "b"],
});

describe("expressions in a version 1.1 run", () => {
  const spec = make(
    {
      tools: [
        {
          name: "lookup",
          action: "http_request",
          method: "GET",
          url: "https://api.test/alerts/{{ trigger.alerts[0].id }}?r={{ vars.region }}",
        },
        {
          name: "notify",
          action: "http_request",
          method: "GET",
          url: "https://api.test/notify/{{ fetch.items[1].name }}/{{ $count(fetch.items) }}",
        },
      ],
      workflow: [
        { step: "fetch", type: "tool", tool: "lookup" },
        {
          step: "decide",
          type: "condition",
          if: "$abs(trigger.change) >= vars.threshold and $count(fetch.items) > 0",
          then: "execute_tool(notify)",
          else: "request_human_approval",
        },
      ],
    },
    {
      threshold: { type: "number", default: 5 },
      region: { type: "string", default: "eu" },
    },
  );

  it("resolves templates from the trigger and vars, and conditions from vars and earlier outputs", async () => {
    const urls: string[] = [];
    const events = await drive(spec, ALERT, { fetchImpl: fetchOf(urls) });
    expect(failed(events)).toBeUndefined();
    expect(last(events).type).toBe("completed");
    expect(urls).toEqual([
      "https://api.test/alerts/A1?r=eu",
      // A deep path into the earlier step's full output, and an expression, inside a URL.
      "https://api.test/notify/y/2",
    ]);
  });

  it("takes the else branch when the condition is false", async () => {
    const events = await drive(
      spec,
      ALERT,
      { fetchImpl: fetchOf([]), vars: { threshold: 50 } },
      () => ({
        approved: false,
        reason: "no",
      }),
    );
    expect(events.map((e) => e.type)).toContain("awaiting_approval");
    expect(last(events).type).toBe("rejected");
  });

  it("lets an override win over a default, and an environment variable fill a ${ENV} default", async () => {
    const urls: string[] = [];
    const withEnv = make(
      { ...spec.agent, tools: spec.agent.tools },
      {
        threshold: { type: "number", default: "${T}" },
        region: { type: "string", default: "${R}" },
      },
    );
    await drive(withEnv, ALERT, { fetchImpl: fetchOf(urls), env: { T: "1", R: "us" } });
    expect(urls[0]).toBe("https://api.test/alerts/A1?r=us");
    const urls2: string[] = [];
    await drive(withEnv, ALERT, {
      fetchImpl: fetchOf(urls2),
      env: { T: "1", R: "us" },
      vars: { region: "ap" },
    });
    expect(urls2[0]).toBe("https://api.test/alerts/A1?r=ap");
  });

  it("fails before any step when a var has no value, naming it", async () => {
    const urls: string[] = [];
    const events = await drive(spec, ALERT, { fetchImpl: fetchOf(urls), vars: {} }, undefined);
    expect(events.map((e) => e.type)).not.toContain("failed"); // defaults exist
    const needs = make({ ...spec.agent }, { threshold: { type: "number" } });
    const bad = await drive(needs, ALERT, { fetchImpl: fetchOf(urls) });
    expect(bad).toHaveLength(1);
    expect(failed(bad)!.error).toBe(
      "vars.threshold: no value: it has no default and none was given",
    );
    expect(failed(bad)!.step).toBeUndefined();
  });

  it("reads trigger headers, and the body as a whole, as well as its fields", async () => {
    const s = make({
      tools: [
        {
          name: "t",
          action: "http_request",
          method: "GET",
          url: "https://x.test/{{ trigger.headers.`x-event` }}/{{ $count(trigger.body.tags) }}/{{ trigger.change }}",
        },
      ],
      workflow: [{ step: "go", type: "tool", tool: "t" }],
    });
    const urls: string[] = [];
    await drive(s, ALERT, {
      fetchImpl: fetchOf(urls),
      trigger: { headers: { "x-event": "push" } },
    });
    expect(urls).toEqual(["https://x.test/push/2/-7"]);
  });

  it("takes the input as the body, parsed when it is JSON and kept as text when it is not", async () => {
    const s = make({
      tools: [
        {
          name: "t",
          action: "http_request",
          method: "GET",
          url: "https://x.test/{{ trigger.body }}",
        },
      ],
      workflow: [{ step: "go", type: "tool", tool: "t" }],
    });
    const urls: string[] = [];
    await drive(s, "just words", { fetchImpl: fetchOf(urls) });
    await drive(s, "[1,2]", { fetchImpl: fetchOf(urls) });
    expect(urls).toEqual(["https://x.test/just words", "https://x.test/[1,2]"]);
  });

  it("gives a component its input as typed values: a number stays a number, a list a list", async () => {
    let received: Record<string, unknown> | undefined;
    const components: ComponentDispatcher = {
      async prepare() {
        return {
          requiresApproval: false,
          async run(input) {
            received = input;
            return { ok: true };
          },
        };
      },
    };
    const s = make({
      tools: [
        {
          name: "c",
          action: "component",
          use: "acme/x@1.0.0",
          op: "go",
          with: {
            count: "{{ $count(trigger.tags) }}",
            tags: "{{ trigger.tags }}",
            text: "n={{ trigger.change }}",
            fixed: 7,
            nested: { id: "{{ trigger.alerts[0].id }}" },
          },
        },
      ],
      workflow: [{ step: "go", type: "tool", tool: "c" }],
    });
    const events = await drive(s, ALERT, { components });
    expect(failed(events)).toBeUndefined();
    expect(received).toEqual({
      count: 2,
      tags: ["a", "b"],
      text: "n=-7",
      fixed: 7,
      nested: { id: "A1" },
    });
  });

  it("resolves an approval message and an action step's query", async () => {
    prompts.length = 0;
    const s = make({
      workflow: [
        {
          step: "draft",
          action: "write",
          query: "Summarise {{ trigger.alerts[0].labels.alertname }}",
        },
        {
          step: "ask",
          type: "approval",
          message: "Send {{ $count(trigger.tags) }} tags for {{ trigger.alerts[0].id }}?",
        },
      ],
    });
    const asked: string[] = [];
    await drive(s, ALERT, {}, (ev) => {
      asked.push(ev.reason);
      return { approved: true };
    });
    expect(prompts[0]).toContain("Query: Summarise HighCPU");
    expect(asked).toEqual(["Send 2 tags for A1?"]);
  });

  it("does not treat a step's output as the trigger: the reserved names win over a step's", async () => {
    const s = make({
      workflow: [
        { step: "a", action: "say" },
        {
          step: "decide",
          type: "condition",
          if: "$exists(trigger.change) and a.text = 'drafted'",
          then: "request_human_approval",
          else: "request_human_approval",
        },
      ],
    });
    expect(failed(await drive(s, ALERT))).toBeUndefined();
  });
});

describe("the data an expression reads", () => {
  it("lets the reserved names win over a step that shares one (the spec refuses such a name, the engine does not trust that)", async () => {
    const s = make(
      {
        tools: [
          {
            name: "t",
            action: "http_request",
            method: "GET",
            url: "https://x.test/{{ trigger.n }}/{{ vars.k }}/{{ input }}",
          },
        ],
        workflow: [
          { step: "trigger", action: "say" },
          { step: "vars", action: "say" },
          { step: "go", type: "tool", tool: "t" },
        ],
      },
      { k: { type: "string", default: "kv" } },
    );
    const urls: string[] = [];
    await drive(s, '{"n": 4}', { fetchImpl: fetchOf(urls) });
    expect(urls).toEqual(['https://x.test/4/kv/{"n": 4}']);
  });

  it("leaves a tool's identity alone: a name that looks like a template is not evaluated", async () => {
    const s = make({
      tools: [
        { name: "a{{ trigger.n }}", action: "http_request", method: "GET", url: "https://x.test/" },
      ],
      workflow: [{ step: "go", type: "tool", tool: "a{{ trigger.n }}" }],
    });
    const failingFetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const events = await drive(s, '{"n": 4}', { fetchImpl: failingFetch });
    expect(failed(events)!.error).toContain('Tool "a{{ trigger.n }}"');
  });
});

describe("expression failures are failures of the step, with where", () => {
  const conditionSpec = (ifExpr: string) =>
    make({
      workflow: [
        { step: "first", action: "say" },
        {
          step: "decide",
          type: "condition",
          if: ifExpr,
          then: "request_human_approval",
          else: "request_human_approval",
        },
      ],
    });

  it("a condition that reads nothing fails the run, naming the step and the expression", async () => {
    const events = await drive(conditionSpec("first.score > 0.5"), "x");
    expect(failed(events)).toMatchObject({ step: "decide" });
    expect(failed(events)!.error).toMatch(
      /Step "decide": .*evaluated to nothing.*\[first\.score > 0\.5\]/s,
    );
  });

  it("a condition that is not true or false fails it", async () => {
    const events = await drive(conditionSpec("first.text"), "x");
    expect(failed(events)!.error).toMatch(/must evaluate to true or false, not string/);
  });

  it("a syntax error is reported with its character", async () => {
    const events = await drive(conditionSpec("first.text = = 'x'"), "x");
    expect(failed(events)!.error).toMatch(/\(character \d+\)/);
  });

  it("a template that reads nothing fails the tool step before anything is called", async () => {
    const urls: string[] = [];
    const s = make({
      tools: [
        {
          name: "t",
          action: "http_request",
          method: "GET",
          url: "https://x.test/{{ trigger.missing }}",
        },
      ],
      workflow: [{ step: "go", type: "tool", tool: "t" }],
    });
    const events = await drive(s, ALERT, { fetchImpl: fetchOf(urls) });
    expect(failed(events)!.error).toMatch(/Step "go": .*evaluated to nothing/s);
    expect(urls).toEqual([]);
  });

  it("a template that fails does so before a human is asked to approve the call", async () => {
    const s = make({
      tools: [
        {
          name: "t",
          action: "http_request",
          method: "POST",
          url: "https://x.test/{{ trigger.missing }}",
          requires_approval: true,
        },
      ],
      workflow: [{ step: "go", type: "tool", tool: "t" }],
    });
    const events = await drive(s, ALERT, { fetchImpl: fetchOf([]) });
    expect(events.map((e) => e.type)).not.toContain("awaiting_approval");
    expect(failed(events)).toBeDefined();
  });

  it("refuses the clock and randomness, which would make a run differ from its replay", async () => {
    const events = await drive(conditionSpec("$now() > 0"), "x");
    expect(failed(events)!.error).toMatch(/\$now is not available/);
  });

  it("is bounded: a runaway expression fails the step instead of hanging the run", async () => {
    const events = await drive(conditionSpec("($f := function($x){$f($x+1)}; $f(0)) > 0"), "x", {
      expressionLimits: { timeoutMs: 200 },
    });
    expect(failed(events)!.error).toMatch(/Step "decide"/);
  });
});

describe("version 1.0 is unchanged", () => {
  it("keeps the original condition grammar and placeholders, and ignores trigger and vars", async () => {
    const urls: string[] = [];
    const legacy = {
      ...make({
        tools: [
          {
            name: "t",
            action: "http_request",
            method: "GET",
            url: "https://x.test/{{ first.text }}",
          },
        ],
        workflow: [
          { step: "first", action: "say" },
          {
            step: "decide",
            type: "condition",
            if: 'first.text == "drafted"',
            then: "execute_tool(t)",
            else: "request_human_approval",
          },
        ],
      }),
      version: "1.0",
    } as AgentSpec;
    const events = await drive(legacy, "x", { fetchImpl: fetchOf(urls), vars: { ignored: 1 } });
    expect(failed(events)).toBeUndefined();
    expect(urls).toEqual(["https://x.test/drafted"]);
  });
});
