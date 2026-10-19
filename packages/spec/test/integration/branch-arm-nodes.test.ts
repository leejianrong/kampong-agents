import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addTargets } from "../../src/add-targets.js";
import { specToGraph } from "../../src/graph.js";
import { withAutoLayout } from "../../src/layout.js";
import { applyPatch } from "../../src/mutate.js";
import { applyOpsToSource } from "../../src/ops.js";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { branchToEditInput, buildBranchEdit, listSteps } from "../../src/step-edit.js";
import { buildWorkflowStepFromForm } from "../../src/workflow-form.js";

// KAM-154: a branch's arms are nodes of their own with edges in run order, the branch's own field is editable, a
// switch can be built from the form, and a step of any kind can be added to an arm.

const ETL = readFileSync(
  fileURLToPath(new URL("../../../cli/templates/market-etl/agent.yaml", import.meta.url)),
  "utf8",
);

const SWITCH = `# triage
version: "1.1"
agent:
  id: triage
  name: Triage
  role: R
  goal: G
  tools:
    - name: reply
      action: http_request
      method: POST
      url: "https://x.example/reply"
  workflow:
    - step: route
      branch:
        switch: "trigger.kind" # what kind of message
        cases:
          bug:
            - step: answer
              type: tool
              tool: reply
            - step: log_bug
              type: transform
              set:
                kind: "'bug'"
          dup:
            - step: ignore
              stop:
                reason: duplicate
        default:
          - step: other
            type: tool
            tool: reply
    - step: wrap
      type: transform
      set:
        done: "true"
`;

const ids = (list: { id: string }[]) => list.map((n) => n.id.replace("workflow:", ""));
const into = (graph: ReturnType<typeof specToGraph>, target: string) =>
  graph.edges
    .filter((e) => e.target === `workflow:${target}`)
    .map((e) => [e.source.replace("workflow:", ""), e.label]);

describe("specToGraph with branch arms", () => {
  const graph = specToGraph(parseSpec(SWITCH).spec!);

  it("makes each arm step a node in its branch, tagged with its arm", () => {
    const arms = graph.nodes.filter((n) => n.parent === "workflow:route");
    expect(ids(arms)).toEqual(["answer", "log_bug", "ignore", "other"]);
    expect(arms.map((n) => n.arm)).toEqual(["case bug", "case bug", "case dup", "default"]);
  });

  it("joins the branch to each arm by label, chains an arm, and ends a stop's arm", () => {
    expect(into(graph, "answer")).toEqual([["route", "case bug"]]);
    expect(into(graph, "log_bug")).toEqual([["answer", undefined]]);
    expect(into(graph, "ignore")).toEqual([["route", "case dup"]]);
    // The next step is reached from every arm that does not stop (the stop's arm does not lead on).
    expect(into(graph, "wrap")).toEqual([
      ["log_bug", undefined],
      ["other", undefined],
    ]);
    expect(graph.edges.map((e) => e.id)).toHaveLength(new Set(graph.edges.map((e) => e.id)).size);
  });

  it("goes straight on from a branch with no else, and from the template's anomaly branch", () => {
    const etl = specToGraph(parseSpec(ETL).spec!);
    expect(into(etl, "summarize")).toEqual([["anomaly", "then"]]);
    expect(into(etl, "report")).toEqual([
      ["alert", undefined],
      ["anomaly", "else"],
    ]);
  });

  it("lays arm steps out in run order under their branch when there is no layout entry", () => {
    const layout = withAutoLayout({}, graph.nodes);
    const order = ["route", "answer", "log_bug", "ignore", "other", "wrap"];
    const ys = order.map((n) => layout[`workflow:${n}`]!.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(new Set(ys).size).toBe(ys.length);
    expect(layout["workflow:answer"]!.x).toBeGreaterThan(layout["workflow:route"]!.x);
  });
});

describe("editing the branch's own field", () => {
  const ref = () => {
    const { spec, doc } = parseSpec(SWITCH);
    const r = listSteps(spec!).find((s) => s.name === "route")!;
    return { doc, r: r as typeof r & { step: Parameters<typeof branchToEditInput>[0] } };
  };

  it("changes the switch value only, keeps its comment, and is a fixed point", () => {
    const { r, doc } = ref();
    const res = buildBranchEdit({ mode: "switch", expression: "trigger.type" }, r, "1.1");
    if (!res.success) throw new Error(res.errors.join());
    applyPatch(doc, res.patch);
    const out = toYamlString(doc);
    expect(out).toContain(`switch: "trigger.type" # what kind of message`);
    const reparsed = parseSpec(out);
    expect(reparsed.errors).toEqual([]);
    expect(toYamlString(reparsed.doc)).toBe(out);
  });

  it("does nothing when untouched and refuses an empty or unparsable value", () => {
    const { r } = ref();
    expect(buildBranchEdit(branchToEditInput(r.step), r, "1.1")).toEqual({
      success: true,
      patch: [],
    });
    expect(buildBranchEdit({ mode: "switch", expression: "  " }, r, "1.1").success).toBe(false);
    expect(buildBranchEdit({ mode: "switch", expression: "a +" }, r, "1.1").success).toBe(false);
  });
});

describe("the switch form", () => {
  it("builds cases, with several steps in one case, and a default", () => {
    const built = buildWorkflowStepFromForm({
      kind: "branch",
      step: "route",
      if: "",
      then: "",
      switch: "trigger.kind",
      cases: "bug: send_bug: reply\nbug: log_bug: reply\nbilling: reply",
      default: "other: reply",
    });
    expect(built.errors).toBeUndefined();
    expect(built.step).toEqual({
      step: "route",
      branch: {
        switch: "trigger.kind",
        cases: {
          bug: [
            { step: "send_bug", type: "tool", tool: "reply" },
            { step: "log_bug", type: "tool", tool: "reply" },
          ],
          billing: [{ step: "reply", type: "tool", tool: "reply" }],
        },
        default: [{ step: "other", type: "tool", tool: "reply" }],
      },
    });
  });

  it("says plainly what is missing", () => {
    expect(
      buildWorkflowStepFromForm({ kind: "branch", step: "r", if: "", then: "", switch: "x" })
        .errors,
    ).toEqual(["Add at least one case as value: step: tool"]);
    expect(
      buildWorkflowStepFromForm({
        kind: "branch",
        step: "r",
        if: "",
        then: "",
        switch: "x",
        cases: "no colon here",
      }).errors?.[0],
    ).toContain('is not "value: step: tool"');
  });
});

describe("adding to an arm", () => {
  const targets = (source: string) => addTargets(parseSpec(source).spec!);

  it("offers each arm, with the else or default that is not there yet", () => {
    expect(targets(SWITCH).map((t) => t.id)).toEqual([
      "route/cases/bug",
      "route/cases/dup",
      "route/default",
    ]);
    const etl = targets(ETL).map((t) => t.id);
    expect(etl).toEqual(["each_symbol/steps", "anomaly/then", "anomaly/else"]);
  });

  const insert = (
    source: string,
    id: string,
    form: Parameters<typeof buildWorkflowStepFromForm>[0],
  ) => {
    const target = targets(source).find((t) => t.id === id)!;
    const built = buildWorkflowStepFromForm(form);
    expect(built.errors).toBeUndefined();
    return applyOpsToSource(source, [
      {
        op: "step.insert",
        place: target.place,
        step: built.step as unknown as Record<string, unknown>,
      },
    ]);
  };

  it.each([
    { kind: "transform" as const, step: "n_t", set: "a: 'x'" },
    { kind: "validate" as const, step: "n_v", assert: "true" },
    { kind: "approval" as const, step: "n_ap", message: "ok?" },
    { kind: "stop" as const, step: "n_s", reason: "done" },
  ])("adds a $kind step to an arm outside a loop, and the file stays valid", (form) => {
    const res = insert(SWITCH, "route/default", form);
    if (!res.success) throw new Error(res.errors.map((e) => e.message).join());
    expect(parseSpec(res.source).errors).toEqual([]);
    expect(res.source).toContain(`step: ${form.step}`);
  });

  it("says plainly that a step after a stop can never run", () => {
    const res = insert(SWITCH, "route/cases/dup", {
      kind: "transform",
      step: "late",
      set: "a: 'x'",
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.errors[0]!.message).toContain("unreachable step");
  });

  it("creates an else that was not there", () => {
    const res = insert(ETL, "anomaly/else", { kind: "transform", step: "calm", set: "a: 'x'" });
    if (!res.success) throw new Error(res.errors.map((e) => e.message).join());
    expect(res.source).toMatch(/else:\n\s+- step: calm/);
    expect(parseSpec(res.source).errors).toEqual([]);
  });

  it("refuses an approval in an arm inside a loop, plainly", () => {
    const res = insert(ETL, "anomaly/then", { kind: "approval", step: "ask", message: "ok?" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.errors[0]!.code).toBe("approval_in_foreach");
  });

  it("deletes a step from an arm, and refuses to empty it", () => {
    const ok = applyOpsToSource(SWITCH, [{ op: "step.remove", step: "log_bug" }]);
    expect(ok.success).toBe(true);
    const empty = applyOpsToSource(SWITCH, [{ op: "step.remove", step: "other" }]);
    expect(empty.success).toBe(false);
  });
});
