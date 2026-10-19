import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expressionScopeForLoopBody } from "../../src/expression-assist.js";
import { specToGraph } from "../../src/graph.js";
import { withAutoLayout } from "../../src/layout.js";
import { applyPatch } from "../../src/mutate.js";
import { applyOpsToSource } from "../../src/ops.js";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { buildForEachEdit, forEachToEditInput, listSteps } from "../../src/step-edit.js";
import { buildWorkflowStepFromForm } from "../../src/workflow-form.js";

// KAM-153: a foreach's body steps are nodes of their own, the loop is editable, and every kind of step except an
// approval can be added to a body. The market-etl template (a foreach over eight body steps) is the fixture.

const SOURCE = readFileSync(
  fileURLToPath(new URL("../../../cli/templates/market-etl/agent.yaml", import.meta.url)),
  "utf8",
);
const BODY = ["fetch", "check", "shape", "sane", "delta", "row", "write", "anomaly"];

const load = () => {
  const { doc, spec } = parseSpec(SOURCE);
  return { doc, spec: spec! };
};

describe("specToGraph with a foreach", () => {
  it("makes each body step a node, in the loop, with edges in run order", () => {
    const graph = specToGraph(load().spec);
    const nested = graph.nodes.filter((n) => n.parent === "workflow:each_symbol");
    expect(nested.map((n) => n.id)).toEqual(BODY.map((n) => `workflow:${n}`));
    const chain = ["each_symbol", ...BODY, "report"].map((n) => `workflow:${n}`);
    const edges = graph.edges.filter((e) => chain.includes(e.source) && chain.includes(e.target));
    expect(edges.map((e) => [e.source, e.target])).toEqual(
      chain.slice(1).map((id, i) => [chain[i], id]),
    );
    expect(graph.edges.map((e) => e.target)).toHaveLength(
      new Set(graph.edges.map((e) => e.id)).size,
    );
  });

  it("lays body steps out below their loop, indented, when there is no layout entry", () => {
    const graph = specToGraph(load().spec);
    const layout = withAutoLayout(
      {},
      graph.nodes.map((n) => ({ id: n.id, column: n.column })),
    );
    const loop = layout["workflow:each_symbol"]!;
    const ys = BODY.map((n) => layout[`workflow:${n}`]!.y);
    expect(ys).toEqual(BODY.map((_, i) => loop.y + (i + 1) * 120));
    expect(layout["workflow:fetch"]!.x).toBeGreaterThan(loop.x);
    expect(layout["workflow:report"]!.y).toBeGreaterThan(ys.at(-1)!);
    // The keys are the step names (ADR-0006, ADR-0055), and a stored position is kept.
    const kept = withAutoLayout({ "workflow:fetch": { x: 9, y: 9 } }, graph.nodes);
    expect(kept["workflow:fetch"]).toEqual({ x: 9, y: 9 });
  });

  it("is unchanged for a spec with no loop", () => {
    const { spec } = parseSpec(`version: "1.0"
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: one
      action: x
    - step: two
      action: y
`);
    const graph = specToGraph(spec!);
    expect(graph.nodes.every((n) => n.parent === undefined && Number.isInteger(n.column))).toBe(
      true,
    );
    expect(graph.edges).toHaveLength(2);
  });
});

describe("editing the loop", () => {
  const ref = () => {
    const { spec, doc } = load();
    const r = listSteps(spec).find((s) => s.name === "each_symbol")!;
    return { spec, doc, r: r as typeof r & { step: Parameters<typeof forEachToEditInput>[0] } };
  };

  it("is a no-op when untouched", () => {
    const { r } = ref();
    expect(buildForEachEdit(forEachToEditInput(r.step), r, "1.1")).toEqual({
      success: true,
      patch: [],
    });
  });

  it("changes only the edited fields, keeps comments, and is a fixed point", () => {
    const { r, doc } = ref();
    const input = { ...forEachToEditInput(r.step), concurrency: "4", onError: "retry" as const };
    const res = buildForEachEdit(input, r, "1.1");
    if (!res.success) throw new Error(res.errors.join());
    applyPatch(doc, res.patch);
    const edited = toYamlString(doc);
    const before = SOURCE.split("\n");
    const after = edited.split("\n");
    expect(after.filter((l) => !before.includes(l))).toEqual([
      "        on_error:",
      "          retry:",
      "            n: 3",
      "        concurrency: 4",
    ]);
    expect(edited.match(/^\s*#.*$/gm)).toEqual(SOURCE.match(/^\s*#.*$/gm));
    const reparsed = parseSpec(edited);
    expect(reparsed.errors).toEqual([]);
    expect(toYamlString(reparsed.doc)).toBe(edited);
  });

  it("refuses a bad loop variable, an unknown name in items and a bad concurrency", () => {
    const { r, spec } = ref();
    const base = forEachToEditInput(r.step);
    const scope = expressionScopeForLoopBody(spec, "each_symbol");
    const res = buildForEachEdit(
      { ...base, as: "1x", items: "vars.nope", concurrency: "99" },
      r,
      "1.1",
      scope,
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.errors.join("\n")).toMatch(/loop variable/);
      expect(res.errors.join("\n")).toMatch(/concurrency/);
      expect(res.errors.join("\n")).toMatch(/items:/);
    }
  });
});

describe("adding to a loop body", () => {
  const place = { in: { step: "each_symbol", slot: "steps" as const } };
  const FORMS = [
    { kind: "action" as const, step: "n_action", action: "say" },
    { kind: "tool" as const, step: "n_tool", tool: "post_alert" },
    { kind: "transform" as const, step: "n_transform", set: "a: symbol" },
    { kind: "validate" as const, step: "n_validate", assert: "symbol != ''" },
    { kind: "dedupe" as const, step: "n_dedupe", key: "symbol", ttl: "24h" },
    { kind: "stop" as const, step: "n_stop", reason: "done" },
    { kind: "branch" as const, step: "n_branch", if: "true", then: "post_alert" },
  ];

  it.each(FORMS)("accepts a $kind step at the end of the body, still in the loop", (form) => {
    const built = buildWorkflowStepFromForm(form);
    expect(built.errors).toBeUndefined();
    const res = applyOpsToSource(SOURCE, [
      { op: "step.insert", place, step: built.step as unknown as Record<string, unknown> },
    ]);
    if (!res.success) throw new Error(res.errors.map((e) => e.message).join());
    const spec = parseSpec(res.source).spec!;
    const loop = listSteps(spec).find((s) => s.name === "each_symbol")!.step as {
      foreach: { steps: { step: string }[] };
    };
    expect(loop.foreach.steps.at(-1)!.step).toBe(form.step);
  });

  it("refuses an approval plainly, and a nested loop", () => {
    const approval = buildWorkflowStepFromForm({ kind: "approval", step: "ask", message: "ok?" });
    const res = applyOpsToSource(SOURCE, [
      { op: "step.insert", place, step: approval.step as unknown as Record<string, unknown> },
    ]);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.errors[0]!.code).toBe("approval_in_foreach");
    const nested = buildWorkflowStepFromForm({
      kind: "foreach",
      step: "inner",
      items: "vars.symbols",
      as: "s2",
      body: "post_alert",
    });
    const res2 = applyOpsToSource(SOURCE, [
      { op: "step.insert", place, step: nested.step as unknown as Record<string, unknown> },
    ]);
    expect(res2.success).toBe(false);
    if (!res2.success) expect(res2.errors[0]!.code).toBe("nested_foreach");
  });

  it("scopes an expression to the loop variable and the body so far", () => {
    const scope = expressionScopeForLoopBody(load().spec, "each_symbol");
    expect(scope.local?.map((s) => s.name)).toEqual(["symbol", ...BODY]);
    expect(scope.ready?.map((s) => s.name)).not.toContain("report");
  });
});
