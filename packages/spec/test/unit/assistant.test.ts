import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  STEP_EXAMPLES,
  TOOL_EXAMPLES,
  TRIGGER_EXAMPLES,
  assistantCatalogue,
  parseAssistantReply,
  parseSpec,
  planToOps,
  type AssistantPlan,
} from "../../src/index.js";

// KAM-249: the assistant's catalogue cannot drift from the schema, a model's reply is read strictly, and a plan
// becomes mutation ops only if the result loads as an AgentSpec.

const base = (extra: Record<string, unknown> = {}) =>
  stringify({
    version: "1.1",
    vars: { symbol: { type: "string", default: "AAPL" } },
    agent: {
      id: "demo",
      name: "Demo",
      role: "Analyst",
      goal: "Report.",
      tools: [TOOL_EXAMPLES.http_request!.tool],
      workflow: [
        STEP_EXAMPLES.tool!.step,
        { step: "after", type: "transform", set: { n: "$count(fetch.items)" } },
      ],
      ...extra,
    },
  });

describe("the catalogue", () => {
  it("has examples that load: every step kind, tool kind and trigger", () => {
    const steps = Object.values(STEP_EXAMPLES)
      .map((e) => e.step)
      .filter((s) => s.step !== "fetch");
    const source = stringify({
      version: "1.1",
      vars: { symbol: { type: "string", default: "AAPL" } },
      agent: {
        id: "demo",
        name: "Demo",
        role: "R",
        goal: "G",
        tools: Object.values(TOOL_EXAMPLES).map((e) => e.tool),
        workflow: [STEP_EXAMPLES.tool!.step, ...steps],
      },
    });
    const result = parseSpec(source);
    expect(result.errors).toEqual([]);
    for (const { trigger } of Object.values(TRIGGER_EXAMPLES)) {
      const withTrigger = parseSpec(base({ trigger }));
      expect(withTrigger.errors, JSON.stringify(trigger)).toEqual([]);
    }
  });

  it("lists the installed components for the model", () => {
    const text = assistantCatalogue([{ use: "kampong/slack@1.0.0", ops: ["post_message"] }]);
    expect(text).toContain("kampong/slack@1.0.0: ops post_message");
    expect(assistantCatalogue()).toContain("- none");
  });
});

describe("parseAssistantReply", () => {
  const plan = { summary: "Adds a step.", edits: [{ kind: "remove_step", step: "after" }] };

  it("reads bare JSON and JSON in a code fence with chatter around it", () => {
    const bare = parseAssistantReply(JSON.stringify(plan));
    expect(bare).toEqual({ ok: true, plan });
    const fenced = parseAssistantReply(`Sure!\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\nDone.`);
    expect(fenced).toEqual({ ok: true, plan });
  });

  it("says what is wrong with a reply that is not a plan", () => {
    expect(parseAssistantReply("no json here")).toMatchObject({ ok: false });
    expect(parseAssistantReply("{ not json }")).toMatchObject({ ok: false });
    const bad = parseAssistantReply(JSON.stringify({ summary: "x", edits: [{ kind: "explode" }] }));
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.error).toMatch(/edits/);
  });

  it("refuses an edit that reaches for the model block or any other field it was not given", () => {
    const sneaky = parseAssistantReply(
      JSON.stringify({
        summary: "x",
        edits: [{ kind: "set_agent", fields: { model: { provider: "openai", name: "x" } } }],
      }),
    );
    expect(sneaky.ok).toBe(false);
  });
});

describe("planToOps", () => {
  const plan = (edits: AssistantPlan["edits"]): AssistantPlan => ({ summary: "s", edits });

  it("adds a step, a tool and shows what it added", () => {
    const result = planToOps(
      base(),
      plan([
        { kind: "add_tool", tool: TOOL_EXAMPLES.slack_post_message!.tool },
        {
          kind: "add_step",
          step: { step: "tell", type: "tool", tool: "notify" },
        },
      ]),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.added).toEqual([
      { kind: "step", name: "tell" },
      { kind: "tool", name: "notify" },
    ]);
    expect(result.source).toContain("notify");
    expect(result.ops.map((o) => o.op)).toEqual(["add", "step.insert"]);
  });

  it("places a step where asked and moves, renames and removes by name", () => {
    const result = planToOps(
      base(),
      plan([
        {
          kind: "add_step",
          place: { in: "workflow", index: 0 },
          step: { step: "first", type: "transform", set: { a: "1" } },
        },
        { kind: "rename_step", step: "after", to: "finish" },
      ]),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.spec.agent.workflow.map((s) => s.step)).toEqual(["first", "fetch", "finish"]);
    expect(result.diff.changed).toEqual([]);
    expect(result.diff.added.map((i) => i.name)).toContain("first");
  });

  it("replaces a step in place, as a change, leaving the others as they were", () => {
    const result = planToOps(
      base(),
      plan([
        {
          kind: "replace_step",
          step: "after",
          with: { step: "after", type: "transform", set: { n: "1" } },
        },
      ]),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff).toEqual({
      added: [],
      removed: [],
      changed: [{ kind: "step", name: "after" }],
    });
  });

  it("does replace edits against the file as it is, even after an earlier add", () => {
    const result = planToOps(
      base(),
      plan([
        {
          kind: "add_step",
          place: { in: "workflow", index: 0 },
          step: { step: "first", type: "transform", set: { a: "1" } },
        },
        {
          kind: "replace_step",
          step: "after",
          with: { step: "after", type: "transform", set: { n: "2" } },
        },
      ]),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.spec.agent.workflow.map((s) => s.step)).toEqual(["first", "fetch", "after"]);
  });

  it("reports, in words, an edit that names something that is not there", () => {
    const result = planToOps(
      base(),
      plan([{ kind: "replace_step", step: "nope", with: { step: "nope" } }]),
    );
    expect(result).toEqual({
      success: false,
      errors: ['There is no step named "nope" (use add_step for a new one).'],
    });
  });

  it("refuses a plan whose result is not a valid spec, and applies nothing", () => {
    const result = planToOps(
      base(),
      plan([{ kind: "add_step", step: { step: "bad", type: "tool", tool: "no_such_tool" } }]),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors.join("\n")).toMatch(/no_such_tool|tool/);
  });

  it("refuses removing a step that others read, naming the reader", () => {
    const result = planToOps(base(), plan([{ kind: "remove_step", step: "fetch" }]));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors.join("\n")).toMatch(/fetch/);
  });

  it("will not rename a step by replacing it, nor change nothing", () => {
    const rename = planToOps(
      base(),
      plan([
        {
          kind: "replace_step",
          step: "after",
          with: { step: "other", type: "transform", set: { a: "1" } },
        },
      ]),
    );
    expect(rename).toMatchObject({ success: false });
    expect(planToOps(base(), plan([]))).toEqual({
      success: false,
      errors: ["The plan changes nothing."],
    });
  });

  it("upgrades a 1.0 workflow first when the plan needs 1.1", () => {
    const old = `version: "1.0"
agent:
  id: old
  name: Old
  role: R
  goal: G
  workflow:
    - step: answer
      action: generate_text
      inputs: [input]
`;
    const result = planToOps(
      old,
      plan([
        { kind: "upgrade_to_1_1" },
        { kind: "add_step", step: { step: "shape", type: "transform", set: { a: "1" } } },
      ]),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.spec.version).toBe("1.1");
    expect(planToOps(base(), plan([{ kind: "upgrade_to_1_1" }]))).toMatchObject({ success: false });
  });

  it("sets the agent's text and trigger, and a var", () => {
    const result = planToOps(
      base(),
      plan([
        {
          kind: "set_agent",
          fields: { goal: "Report daily.", trigger: TRIGGER_EXAMPLES.schedule!.trigger },
        },
        { kind: "set_var", name: "limit", var: { type: "number", default: 5 } },
      ]),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.spec.agent.goal).toBe("Report daily.");
    expect(result.spec.agent.trigger?.type).toBe("schedule");
    expect(result.diff.added).toContainEqual({ kind: "var", name: "limit" });
    expect(result.diff.changed).toContainEqual({ kind: "agent", name: "agent" });
  });
});
