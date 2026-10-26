import { describe, expect, it } from "vitest";
import { planPreview, planToOps, parseSpec, type AssistantPlan } from "../../src/index.js";

// KAM-206: the preview is the plan's result plus what it removes, each marked.

const SOURCE = `version: "1.1"
agent:
  id: demo
  name: Demo
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
    - step: shape
      type: transform
      set: { n: "1" }
    - step: after
      type: transform
      set: { m: "2" }
`;

function preview(edits: AssistantPlan["edits"]) {
  const planned = planToOps(SOURCE, { summary: "s", edits });
  if (!planned.success) throw new Error(planned.errors.join("; "));
  const current = parseSpec(SOURCE).spec!;
  return planPreview(current, planned.spec, planned.diff);
}

describe("planPreview", () => {
  it("marks an added step, a changed step and the settings, and lays every node out", () => {
    const p = preview([
      { kind: "add_step", step: { step: "extra", type: "transform", set: { x: "1" } } },
      {
        kind: "replace_step",
        step: "after",
        with: { step: "after", type: "transform", set: { m: "3" } },
      },
      { kind: "set_agent", fields: { goal: "New goal" } },
    ]);
    expect(p.marks).toEqual({
      "workflow:extra": "add",
      "workflow:after": "change",
      "agent:demo": "change",
    });
    for (const n of p.graph.nodes) expect(p.layout[n.id], n.id).toBeDefined();
    // The changed card shows the new settings.
    expect(p.graph.nodes.find((n) => n.id === "workflow:after")!.data.set).toEqual({ m: "3" });
  });

  it("keeps a removed step in its place, marked, with its lines", () => {
    const p = preview([{ kind: "remove_step", step: "shape" }]);
    expect(p.marks).toEqual({ "workflow:shape": "remove" });
    expect(p.graph.nodes.map((n) => n.id)).toEqual([
      "agent:demo",
      "tool:fetch_page",
      "workflow:get",
      "workflow:shape",
      "workflow:after",
    ]);
    const lines = p.graph.edges.map((e) => `${e.source}>${e.target}`);
    expect(lines).toContain("workflow:get>workflow:shape");
    expect(lines).toContain("workflow:shape>workflow:after");
    // The line that closes the gap is there too.
    expect(lines).toContain("workflow:get>workflow:after");
  });

  it("marks a removed tool and a tool added, and ignores a variable", () => {
    const p = preview([
      {
        kind: "add_tool",
        tool: { name: "other", action: "http_request", method: "GET", url: "https://x.test" },
      },
      { kind: "set_var", name: "limit", var: { type: "number", default: 3 } },
    ]);
    expect(p.marks).toEqual({ "tool:other": "add" });
  });

  it("draws a renamed step as the old one removed and the new one added", () => {
    const p = preview([{ kind: "rename_step", step: "after", to: "finish" }]);
    expect(p.marks).toEqual({ "workflow:finish": "add", "workflow:after": "remove" });
  });
});
