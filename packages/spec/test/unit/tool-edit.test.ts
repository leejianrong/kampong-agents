import { describe, expect, it } from "vitest";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { applyPatch } from "../../src/mutate.js";
import { buildComponentToolFromForm, buildOpInput, planOpForm } from "../../src/component-form.js";
import { buildToolFromForm, parseKeyValueLines } from "../../src/tool-form.js";
import {
  buildSimpleStepEdit,
  isSimpleStep,
  listSteps,
  simpleStepToEditInput,
} from "../../src/step-edit.js";
import {
  httpToolToDraft,
  mergeWith,
  toolEditPatch,
  withToFormValues,
  withToYaml,
} from "../../src/tool-edit.js";
import type { Tool } from "../../src/schema.js";

// KAM-175: editing tools and tool, stop and approval steps. Each case loads real YAML, edits through the same
// helpers the forms use, applies the patch to the document and reads the file back.

const SOURCE = `# a spec
version: "1.1"
agent:
  id: a
  name: A
  role: R
  goal: G
  tools:
    # the price feed
    - name: feed
      action: http_request
      method: GET
      url: "https://example.com/{symbol}" # the symbol
      headers:
        Accept: application/json
      failure_when:
        - path: Note
          exists: true
      requires_approval: false
    - name: notify
      action: slack_post_message
      token: \${SLACK_TOKEN}
      channel: "#a"
      text: hi
      requires_approval: true
    - name: file
      action: component
      use: acme/tickets@1.0.0
      op: create
      with:
        title: "{{ trigger.title }}"
        urgent: false
        owner:
          name: Ann
        legacy_key: keep me
  workflow:
    - step: get
      type: tool
      tool: feed
    - step: ask
      type: approval
      message: Ok to send {{ get.price }}?
    - step: halt
      stop:
        reason: nothing to do # why
        status: skipped
`;

const load = () => {
  const { doc, spec, errors } = parseSpec(SOURCE);
  expect(errors).toEqual([]);
  return { doc, spec: spec! };
};

const apply = (ops: Parameters<typeof applyPatch>[1]) => {
  const { doc } = load();
  applyPatch(doc, ops);
  return toYamlString(doc);
};

describe("toolEditPatch: http_request", () => {
  const rebuild = (change: Record<string, unknown> = {}) => {
    const { spec } = load();
    const tool = spec.agent.tools![0] as Extract<Tool, { action: "http_request" }>;
    const d = httpToolToDraft(tool);
    const built = buildToolFromForm({
      name: tool.name,
      method: d.method,
      url: d.url,
      headers: parseKeyValueLines(d.headers, ":").values,
      query: parseKeyValueLines(d.query, "=").values,
      ...(d.extract && { extract: d.extract }),
      ...change,
    });
    expect(built.errors).toBeUndefined();
    return toolEditPatch(["agent", "tools", 0], tool, built.tool!);
  };

  it("is empty when the form is saved untouched", () => {
    expect(rebuild()).toEqual([]);
  });

  it("changes only the edited field and keeps comments, failure_when and requires_approval", () => {
    const ops = rebuild({ url: "https://example.org/{symbol}" });
    expect(ops).toEqual([
      { op: "set", path: ["agent", "tools", 0, "url"], value: "https://example.org/{symbol}" },
    ]);
    const out = apply(ops);
    expect(out).toContain("# the price feed");
    expect(out).toContain("failure_when:");
    expect(out).toContain("requires_approval: false");
    expect(out).toContain('url: "https://example.org/{symbol}" # the symbol');
    expect(parseSpec(out).errors).toEqual([]);
  });

  it("removes a header block that was cleared", () => {
    expect(rebuild({ headers: {} })).toEqual([
      { op: "remove", path: ["agent", "tools", 0, "headers"] },
    ]);
  });

  it("never renames", () => {
    const { spec } = load();
    const tool = spec.agent.tools![0]!;
    const built = { ...tool, name: "other" } as Tool;
    expect(toolEditPatch(["agent", "tools", 0], tool, built)).toEqual([]);
  });
});

describe("toolEditPatch: slack_post_message", () => {
  it("keeps requires_approval, which the form has no control for", () => {
    const { spec } = load();
    const tool = spec.agent.tools![1] as Extract<Tool, { action: "slack_post_message" }>;
    const built = buildToolFromForm({
      kind: "slack_post_message",
      name: tool.name,
      token: tool.token,
      channel: "#b",
      text: tool.text,
    });
    const ops = toolEditPatch(["agent", "tools", 1], tool, built.tool!);
    expect(ops).toEqual([{ op: "set", path: ["agent", "tools", 1, "channel"], value: "#b" }]);
    expect(apply(ops)).toContain("requires_approval: true");
  });
});

describe("component tool inputs", () => {
  const plan = planOpForm({
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string" },
      urgent: { type: "boolean" },
      owner: { type: "object", properties: { name: { type: "string" } } },
    },
  });
  const tool = () => load().spec.agent.tools![2] as Extract<Tool, { action: "component" }>;

  function rebuild(title?: string) {
    const t = tool();
    const seeded = withToFormValues(plan, t.with);
    const values = "values" in seeded ? seeded.values : {};
    const built = buildOpInput(plan, title === undefined ? values : { ...values, title });
    expect(built.errors).toEqual([]);
    const rebuilt = buildComponentToolFromForm({
      name: t.name,
      use: t.use,
      op: t.op,
      with: mergeWith(plan, t, built.input),
    });
    return toolEditPatch(["agent", "tools", 2], t, rebuilt.tool!);
  }

  it("shows the saved inputs as form values and saves them back unchanged", () => {
    // legacy_key has no field and `urgent: false` is the default: both stay, so nothing is written.
    expect(rebuild()).toEqual([]);
  });

  it("changes one input and leaves the others", () => {
    expect(rebuild("New")).toEqual([
      { op: "set", path: ["agent", "tools", 2, "with", "title"], value: "New" },
    ]);
  });

  it("falls back to YAML when a saved value does not fit its field", () => {
    expect(withToFormValues(plan, { title: 5 })).toEqual({
      reason: "title has an unexpected type",
    });
    expect(withToYaml({ a: 1, b: ["x"] })).toBe("a: 1\nb:\n  - x");
    expect(withToYaml(undefined)).toBe("");
  });
});

describe("buildSimpleStepEdit", () => {
  const names = ["feed", "notify", "file"];
  const ref = (name: string) => {
    const r = listSteps(load().spec).find((s) => s.name === name)!;
    expect(isSimpleStep(r.step)).toBe(true);
    return r as typeof r & { step: Parameters<typeof simpleStepToEditInput>[0] };
  };

  it("repoints a tool step, and refuses a tool the agent does not have", () => {
    const r = ref("get");
    const input = simpleStepToEditInput(r.step);
    expect(input).toEqual({ kind: "tool", tool: "feed" });
    expect(buildSimpleStepEdit(input, r, "1.1", names)).toEqual({ success: true, patch: [] });
    expect(buildSimpleStepEdit({ kind: "tool", tool: "notify" }, r, "1.1", names)).toEqual({
      success: true,
      patch: [{ op: "set", path: ["agent", "workflow", 0, "tool"], value: "notify" }],
    });
    expect(buildSimpleStepEdit({ kind: "tool", tool: "nope" }, r, "1.1", names)).toEqual({
      success: false,
      errors: ['"nope" is not a tool of this agent'],
    });
  });

  it("edits a stop's reason and status, keeping its comment, and clears them", () => {
    const r = ref("halt");
    const input = simpleStepToEditInput(r.step);
    expect(input).toEqual({ kind: "stop", reason: "nothing to do", status: "skipped" });
    expect(buildSimpleStepEdit(input, r, "1.1", names)).toEqual({ success: true, patch: [] });
    const res = buildSimpleStepEdit(
      { kind: "stop", reason: "all done", status: "completed" },
      r,
      "1.1",
      names,
    );
    if (!res.success) throw new Error(res.errors.join());
    const out = apply(res.patch);
    expect(out).toContain("reason: all done # why");
    expect(out).toContain("status: completed");
    expect(parseSpec(out).errors).toEqual([]);
    const cleared = buildSimpleStepEdit({ kind: "stop", reason: "", status: "" }, r, "1.1", names);
    if (!cleared.success) throw new Error(cleared.errors.join());
    expect(cleared.patch.map((p) => p.op)).toEqual(["remove", "remove"]);
    expect(parseSpec(apply(cleared.patch)).errors).toEqual([]);
  });

  it("checks a template in a stop reason and edits an approval message", () => {
    const bad = buildSimpleStepEdit(
      { kind: "stop", reason: "x {{ 1 + }}", status: "" },
      ref("halt"),
      "1.1",
      names,
    );
    expect(bad.success).toBe(false);
    expect(
      buildSimpleStepEdit({ kind: "approval", message: "Send it?" }, ref("ask"), "1.1", names),
    ).toEqual({
      success: true,
      patch: [{ op: "set", path: ["agent", "workflow", 1, "message"], value: "Send it?" }],
    });
  });
});
