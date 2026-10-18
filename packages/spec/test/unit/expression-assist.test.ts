import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/parse.js";
import {
  completeExpression,
  diagnoseExpression,
  expressionScopeFor,
  expressionScopeForStepAt,
  type ExpressionScope,
} from "../../src/expression-assist.js";

// KAM-160: what the canvas's expression field is built on.

const SPEC = `version: "1.1"
vars:
  threshold:
    type: number
    default: 5
  symbols:
    type: list
    default: [AAPL]
agent:
  id: a
  name: A
  role: R
  goal: G
  tools:
    - name: t
      action: http_request
      method: GET
      url: "https://x.example/"
  trigger:
    type: webhook
    map:
      severity: trigger.body.sev
  workflow:
    - step: classify
      action: classify
      output_schema:
        type: object
        properties:
          category: { type: string }
          confidence: { type: number }
    - step: shape
      type: transform
      set:
        total: "1 + 1"
        label: "'x'"
    - step: branchy
      branch:
        if: "vars.threshold > 1"
        then:
          - step: inner
            type: tool
            tool: t
    - step: last
      action: write
`;
const spec = parseSpec(SPEC).spec!;
const scope = (before?: string): ExpressionScope =>
  expressionScopeFor(spec, before === undefined ? {} : { before });
const complete = (source: string, explicit = false, before?: string) => {
  const result = completeExpression(source, source.length, scope(before), { explicit });
  return { from: result.from, labels: result.options.map((o) => o.label) };
};

describe("expressionScopeFor", () => {
  it("lists vars, every step (arms included) and each output's known fields", () => {
    const s = scope();
    expect(s.vars).toEqual([
      { name: "threshold", detail: "number" },
      { name: "symbols", detail: "list of string" },
    ]);
    expect(s.steps.map((x) => x.name)).toEqual(["classify", "shape", "branchy", "inner", "last"]);
    expect(s.steps[0]!.fields).toEqual(["category", "confidence"]);
    expect(s.steps[1]!.fields).toEqual(["total", "label"]);
    expect(s.trigger).toEqual(["severity"]);
  });

  it("offers only the steps ahead of the one being edited, but accepts any name", () => {
    const s = scope("shape");
    expect(s.ready!.map((x) => x.name)).toEqual(["classify"]);
    expect(s.steps).toHaveLength(5);
    expect(diagnoseExpression("last.x", s)).toEqual([]);
  });
});

describe("diagnoseExpression", () => {
  it("is quiet for an empty field and for a good expression", () => {
    expect(diagnoseExpression("", scope())).toEqual([]);
    expect(diagnoseExpression("   ", scope())).toEqual([]);
    expect(diagnoseExpression("vars.threshold > classify.confidence", scope())).toEqual([]);
    expect(diagnoseExpression("$count(vars.symbols) > 0 and trigger.body.x", scope())).toEqual([]);
  });

  it("reports a syntax error with its position", () => {
    const [d] = diagnoseExpression("vars.threshold >", scope());
    expect(d!.message).toBeTruthy();
    expect(d!.position).toBeGreaterThan(0);
  });

  it("refuses what the loader refuses: a clock, a regex, an empty expression", () => {
    expect(diagnoseExpression("$now()", scope())[0]!.message).toMatch(/\$now is not available/);
    expect(diagnoseExpression("$contains(a, /x/)", scope())[0]!.message).toMatch(
      /Regular expressions/,
    );
  });

  it("names an undeclared var and an unknown name, with what is available", () => {
    expect(diagnoseExpression("vars.thresh", scope())[0]!.message).toBe(
      "vars.thresh is not declared in vars (declared: threshold, symbols)",
    );
    const [unknown] = diagnoseExpression("nope.x", scope());
    expect(unknown!.message).toContain('"nope" is not something an expression can read');
    expect(unknown!.message).toContain("classify, shape, branchy, inner, last");
  });

  it("does not repeat a message, and a loop's names are in scope when given", () => {
    expect(diagnoseExpression("nope.a and nope.b", scope())).toHaveLength(1);
    const looped = { ...scope(), local: [{ name: "item", fields: [] }] };
    expect(diagnoseExpression("item.symbol", looped)).toEqual([]);
  });

  // The canvas and a save must agree: whatever the field accepts, the loader accepts, and the other way round.
  it.each([
    "vars.threshold > 1",
    "vars.missing > 1",
    "ghost.field",
    "classify.confidence >=",
    "$random() > 0.5",
    "$count(vars.symbols)",
  ])("agrees with the spec loader on %s", (expression) => {
    const source = SPEC.replace('if: "vars.threshold > 1"', `if: ${JSON.stringify(expression)}`);
    const loader = parseSpec(source).errors.some((e) => e.path.join(".").endsWith("branch.if"));
    expect(diagnoseExpression(expression, scope()).length > 0).toBe(loader);
  });
});

describe("completeExpression", () => {
  it("offers the roots and the steps that have run, when asked or once something is typed", () => {
    expect(complete("")).toEqual({ from: 0, labels: [] });
    expect(complete("", true).labels).toEqual([
      "trigger",
      "input",
      "vars",
      "classify",
      "shape",
      "branchy",
      "inner",
      "last",
    ]);
    expect(complete("c")).toEqual({ from: 0, labels: ["classify"] });
    expect(complete("vars.threshold > cl")).toEqual({ from: 17, labels: ["classify"] });
    expect(complete("TR").labels).toEqual(["trigger"]);
  });

  it("only offers steps ahead of the field", () => {
    expect(complete("sh", false, "shape").labels).toEqual([]);
    expect(complete("cl", false, "shape").labels).toEqual(["classify"]);
  });

  it("completes vars, trigger fields and a step's known outputs", () => {
    expect(complete("vars.")).toEqual({ from: 5, labels: ["threshold", "symbols"] });
    expect(complete("vars.sy").labels).toEqual(["symbols"]);
    expect(complete("trigger.").labels).toEqual(["headers", "body", "severity"]);
    expect(complete("classify.").labels).toEqual(["category", "confidence"]);
    expect(complete("shape.t").labels).toEqual(["total"]);
    expect(complete("x + classify.con", false, "last")).toEqual({
      from: 13,
      labels: ["confidence"],
    });
  });

  it("offers nothing it cannot know: deeper paths, strings, functions, a complete name", () => {
    expect(complete("trigger.body.").labels).toEqual([]);
    expect(complete("vars.threshold.").labels).toEqual([]);
    expect(complete("'vars.").labels).toEqual([]);
    expect(complete('"a" & "b" & vars.').labels).toEqual(["threshold", "symbols"]);
    expect(complete("$cou").labels).toEqual([]);
    expect(complete(".x").labels).toEqual([]);
    expect(complete("vars.threshold").labels).toEqual([]);
    expect(complete("1").labels).toEqual([]);
  });

  it("completes at the cursor, not the end", () => {
    const source = "vars.th > 1";
    const result = completeExpression(source, 7, scope());
    expect(result.from).toBe(5);
    expect(result.options.map((o) => o.label)).toEqual(["threshold"]);
  });

  it("a loop variable comes first", () => {
    const looped = { ...scope(), local: [{ name: "item", fields: ["symbol"] }] };
    expect(completeExpression("it", 2, looped).options.map((o) => o.label)).toEqual(["item"]);
    expect(completeExpression("item.", 5, looped).options.map((o) => o.label)).toEqual(["symbol"]);
  });
});

// KAM-164: inside a foreach body an expression may read the loop variable and the body steps ahead of it, which
// the loader allows; the scope used to list only the top-level steps.
describe("expressionScopeForStepAt", () => {
  const LOOP = parseSpec(`version: "1.1"
vars:
  threshold:
    type: number
    default: 1
agent:
  id: a
  name: A
  role: R
  goal: G
  tools:
    - name: t
      action: http_request
      method: GET
      url: "https://x.example/"
  workflow:
    - step: first
      type: transform
      set:
        n: "1"
    - step: each
      foreach:
        items: "[1, 2]"
        as: item
        steps:
          - step: fetch
            type: tool
            tool: t
          - step: shape
            type: transform
            set:
              latest: "fetch.x"
              previous: "fetch.y"
          - step: pick
            branch:
              if: "shape.latest > 1"
              then:
                - step: armed
                  type: transform
                  set:
                    flag: "true"
                - step: after_arm
                  type: transform
                  set:
                    seen: "armed.flag"
          - step: last_in_loop
            type: transform
            set:
              z: "1"
    - step: report
      type: transform
      set:
        n: "1"
`).spec!;
  const at = (path: (string | number)[]) => expressionScopeForStepAt(LOOP, path);
  const body = (i: number) => ["agent", "workflow", 1, "foreach", "steps", i];

  it("gives a body step the loop variable and the body steps ahead of it, with their fields", () => {
    expect(at(body(2)).local).toEqual([
      { name: "item", fields: [] },
      { name: "fetch", fields: [] },
      { name: "shape", fields: ["latest", "previous"] },
    ]);
  });

  it("includes the steps of an earlier arm, as the loader does", () => {
    const inArm = [...body(2), "branch", "then", 1];
    expect(at(inArm).local!.map((s) => s.name)).toEqual(["item", "fetch", "shape", "armed"]);
  });

  it("accepts a reference to an earlier sibling and still flags an unknown name", () => {
    const s = at(body(2));
    expect(diagnoseExpression("shape.latest > 1 and item", s)).toEqual([]);
    expect(diagnoseExpression("nope.x", s)[0]!.message).toMatch(/"nope" is not something/);
  });

  it("offers the loop's siblings and the steps ahead of the loop, not the ones after it", () => {
    const s = at(body(2));
    const labels = completeExpression("", 0, s, { explicit: true }).options.map((o) => o.label);
    expect(labels).toEqual(expect.arrayContaining(["item", "fetch", "shape", "first"]));
    expect(labels).not.toContain("report");
    expect(completeExpression("shape.", 6, s).options.map((o) => o.label)).toEqual([
      "latest",
      "previous",
    ]);
  });

  it("leaves a top-level step as it was: no local names", () => {
    const s = at(["agent", "workflow", 2]);
    expect(s.local).toBeUndefined();
    expect(s.ready!.map((x) => x.name)).toContain("first");
  });
});
