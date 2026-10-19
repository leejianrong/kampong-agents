import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addTargets, insertionMarker, positionChoices } from "../../src/add-targets.js";
import { specToGraph } from "../../src/graph.js";
import { applyOpsToSource } from "../../src/ops.js";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { buildWorkflowStepFromForm } from "../../src/workflow-form.js";

// KAM-173: a step goes where the author chooses: after a named step, or at the start or end of a loop body or a
// branch arm, by plain words and step names, and lands there in the file. market-etl is the fixture.

const ETL = readFileSync(
  fileURLToPath(new URL("../../../cli/templates/market-etl/agent.yaml", import.meta.url)),
  "utf8",
);
const spec = () => parseSpec(ETL).spec!;

const transform = (name: string) =>
  buildWorkflowStepFromForm({ kind: "transform", step: name, set: "a: 'x'" })
    .step as unknown as Record<string, unknown>;

function insertAt(id: string, choice: string, step = transform("added")) {
  const target = addTargets(spec()).find((t) => t.id === id)!;
  const picked = positionChoices(target.where, target.steps).find((c) => c.value === choice)!;
  const place = { ...target.place, ...(picked.index !== undefined && { index: picked.index }) };
  return applyOpsToSource(ETL, [{ op: "step.insert", place, step }]);
}
const ok = (r: ReturnType<typeof insertAt>) => {
  if (!r.success) throw new Error(r.errors.map((e) => e.message).join());
  return r;
};

describe("position choices, in plain words", () => {
  it("names the end, the start and each step, never an index", () => {
    expect(positionChoices("each_symbol", ["fetch", "check"])).toEqual([
      { value: "end", label: "At the end of each_symbol" },
      { value: "start", label: "At the start of each_symbol", index: 0 },
      { value: "after:0", label: "After fetch", index: 1 },
      { value: "after:1", label: "After check", index: 2 },
    ]);
    expect(positionChoices("anomaly (else)", []).map((c) => c.label)).toEqual([
      "At the end of anomaly (else)",
    ]);
  });

  it("lists the names already in each loop and arm", () => {
    const targets = addTargets(spec());
    expect(targets.find((t) => t.id === "each_symbol/steps")!.steps).toEqual([
      "fetch",
      "check",
      "shape",
      "sane",
      "delta",
      "row",
      "write",
      "anomaly",
    ]);
    expect(targets.find((t) => t.id === "anomaly/then")!.steps).toEqual(["summarize", "alert"]);
    expect(targets.find((t) => t.id === "anomaly/else")!.steps).toEqual([]);
  });
});

describe("inserting where chosen", () => {
  it("puts a transform after `fetch` inside each_symbol, at that path in the YAML", () => {
    const r = ok(insertAt("each_symbol/steps", "after:0"));
    const loop = parseSpec(r.source).spec!.agent.workflow[0] as {
      foreach: { steps: { step: string }[] };
    };
    expect(loop.foreach.steps.map((s) => s.step).slice(0, 3)).toEqual(["fetch", "added", "check"]);
    // Everything else is as it was: one new step's lines, comments kept, and a fixed point.
    const before = ETL.split("\n");
    const added = r.source.split("\n").filter((l) => !before.includes(l));
    expect(added).toEqual(["          - step: added", "              a: \"'x'\""]);
    expect(r.source.match(/^\s*#.*$/gm)).toEqual(ETL.match(/^\s*#.*$/gm));
    const reparsed = parseSpec(r.source);
    expect(reparsed.errors).toEqual([]);
    expect(toYamlString(reparsed.doc)).toBe(r.source);
  });

  it("puts a step at the start of the loop and at the start of a branch arm", () => {
    const loop = parseSpec(ok(insertAt("each_symbol/steps", "start")).source).spec!.agent
      .workflow[0] as { foreach: { steps: { step: string }[] } };
    expect(loop.foreach.steps[0]!.step).toBe("added");
    const arm = parseSpec(ok(insertAt("anomaly/then", "start")).source).spec!.agent.workflow[0] as {
      foreach: { steps: { branch?: { then: { step: string }[] } }[] };
    };
    expect(arm.foreach.steps.at(-1)!.branch!.then.map((s) => s.step)).toEqual([
      "added",
      "summarize",
      "alert",
    ]);
  });

  it("puts a step after a named step in the arm, and at the end of the workflow by index", () => {
    const arm = parseSpec(ok(insertAt("anomaly/then", "after:0")).source).spec!.agent
      .workflow[0] as { foreach: { steps: { branch?: { then: { step: string }[] } }[] } };
    expect(arm.foreach.steps.at(-1)!.branch!.then.map((s) => s.step)).toEqual([
      "summarize",
      "added",
      "alert",
    ]);
    const root = applyOpsToSource(ETL, [
      { op: "step.insert", place: { in: "workflow", index: 0 }, step: transform("first") },
    ]);
    expect(root.success && parseSpec(root.source).spec!.agent.workflow[0]!.step).toBe("first");
  });

  it("refuses an approval in a loop and a nested foreach, plainly, at any position", () => {
    const approval = buildWorkflowStepFromForm({ kind: "approval", step: "ask", message: "ok?" });
    const nested = buildWorkflowStepFromForm({
      kind: "foreach",
      step: "inner",
      items: "vars.symbols",
      as: "s2",
      body: "post_alert",
    });
    const a = insertAt("each_symbol/steps", "after:2", approval.step as never);
    const n = insertAt("each_symbol/steps", "start", nested.step as never);
    expect(!a.success && a.errors[0]!.code).toBe("approval_in_foreach");
    expect(!n.success && n.errors[0]!.code).toBe("nested_foreach");
    expect(!a.success && a.errors[0]!.message).toMatch(/approval|person/i);
  });
});

describe("the insertion marker", () => {
  const graph = specToGraph(spec());
  const body = addTargets(spec()).find((t) => t.id === "each_symbol/steps")!.steps;

  it("sits above the step the new one lands before", () => {
    expect(insertionMarker(graph, "each_symbol", body, 1)).toMatchObject({
      anchor: "workflow:check",
      side: "above",
    });
  });

  it("sits below the last node of the list at the end, with what is inside it", () => {
    // The last body step is the branch; its arms are nodes, so the marker goes under the last of them.
    expect(insertionMarker(graph, "each_symbol", body, undefined)).toMatchObject({
      anchor: "workflow:alert",
      side: "below",
    });
  });

  it("sits below the holder for an empty arm, and below the trigger for an empty workflow", () => {
    expect(insertionMarker(graph, "anomaly", [], undefined)).toMatchObject({
      anchor: "workflow:anomaly",
      side: "below",
    });
    expect(
      insertionMarker({ nodes: graph.nodes.slice(0, 1), edges: [] }, undefined, [], 0),
    ).toMatchObject({
      anchor: graph.nodes[0]!.id,
    });
  });
});
