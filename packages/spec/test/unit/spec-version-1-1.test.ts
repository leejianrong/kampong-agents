import { describe, expect, it } from "vitest";
import { applyPatch } from "../../src/mutate.js";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { specWarnings } from "../../src/warnings.js";
import { VALID_FIXTURE_V1_1, VALID_FIXTURE_WITH_CONDITION } from "../fixtures.js";

// KAN-1840: the spec version gates the syntax. 1.0 keeps the original; 1.1 has expressions and vars.

const messages = (source: string) => parseSpec(source).errors.map((e) => e.message);
const withCondition = (version: string, ifExpr: string, extra = "") => `version: "${version}"
${extra}agent:
  id: a
  name: A
  role: R
  goal: G
  tools:
    - name: t
      action: http_request
      method: GET
      url: "https://x.test/"
  workflow:
    - step: first
      action: classify
    - step: decide
      type: condition
      if: ${JSON.stringify(ifExpr)}
      then: "execute_tool(t)"
      else: "request_human_approval"
`;

describe("spec versions", () => {
  it("accepts 1.0 and 1.1, and refuses any other version by name", () => {
    expect(parseSpec(VALID_FIXTURE_WITH_CONDITION).success).toBe(true);
    expect(parseSpec(VALID_FIXTURE_V1_1).success).toBe(true);
    for (const v of ["2.0", "1.2", "1", "latest"]) {
      const errors = messages(withCondition(v, "first.ok = true"));
      expect(errors.join(" "), v).toMatch(
        /unsupported spec version: this kampong reads "1.0" and "1.1"/,
      );
    }
  });

  it("allows vars only from 1.1", () => {
    const vars = "vars:\n  n: { type: number, default: 1 }\n";
    expect(messages(withCondition("1.0", "first.ok == true", vars))).toEqual([
      'vars needs version "1.1"',
    ]);
    expect(parseSpec(withCondition("1.1", "first.ok = true", vars)).success).toBe(true);
  });
});

describe("vars", () => {
  const v = (decl: string) =>
    messages(withCondition("1.1", "first.ok = true", `vars:\n  x: ${decl}\n`));

  it("accepts each type with a literal or ${ENV} default, and none", () => {
    for (const decl of [
      "{ type: number }",
      "{ type: number, default: 2.5 }",
      '{ type: number, default: "${N}" }',
      '{ type: string, default: "abc" }',
      "{ type: list, default: [a, b] }",
      "{ type: list, items: number, default: [1, 2] }",
      '{ type: list, default: "${L}" }',
      "{ type: string, description: hi }",
    ]) {
      expect(v(decl), decl).toEqual([]);
    }
  });

  it("rejects a default of the wrong type, a stray items, an unknown type and an unknown field", () => {
    expect(v("{ type: number, default: abc }").join(" ")).toMatch(/default must be a number/);
    expect(v("{ type: string, default: 4 }").join(" ")).toMatch(/default must be a string/);
    expect(v("{ type: list, default: [1, 2] }").join(" ")).toMatch(/list of strings/);
    expect(v("{ type: list, items: number, default: [a] }").join(" ")).toMatch(/list of numbers/);
    expect(v("{ type: number, items: string }").join(" ")).toMatch(/"items" only applies/);
    expect(v("{ type: boolean }").length).toBeGreaterThan(0);
    expect(v("{ type: number, bogus: 1 }").length).toBeGreaterThan(0);
  });

  it("rejects a var name that is not an identifier", () => {
    const errors = messages(
      withCondition("1.1", "first.ok = true", "vars:\n  bad-name: { type: number }\n"),
    );
    expect(errors.join(" ")).toMatch(/"bad-name" is not a valid var name/);
  });
});

describe("expressions in a 1.1 spec", () => {
  it("accepts an expression condition that reads steps, vars and the trigger", () => {
    const source = withCondition(
      "1.1",
      "$abs(trigger.change) >= vars.n and first.confidence > 0.5",
      "vars:\n  n: { type: number, default: 1 }\n",
    );
    expect(messages(source)).toEqual([]);
  });

  it("reports a syntax error with the line of the condition and the character in it", () => {
    const result = parseSpec(withCondition("1.1", "first.ok = = true"));
    expect(result.success).toBe(false);
    const [error] = result.errors;
    expect(error!.message).toMatch(/condition "decide": .* \(character \d+\)/);
    expect(error!.path).toEqual(["agent", "workflow", 1, "if"]);
    expect(error!.line).toBe(17);
  });

  it("refuses the non-deterministic functions and regular expressions", () => {
    expect(messages(withCondition("1.1", "$now() > 0")).join(" ")).toMatch(
      /\$now is not available/,
    );
    expect(messages(withCondition("1.1", "$contains(trigger.body, /fix/)")).join(" ")).toMatch(
      /Regular expressions are not available/,
    );
  });

  it("refuses a read that nothing provides: an unknown name, an undeclared var, a var with no vars block", () => {
    expect(messages(withCondition("1.1", "nonsuch.ok = true")).join(" ")).toMatch(
      /"nonsuch" is not something an expression can read: use trigger, input, vars, or the name of a step \(first, decide\)/,
    );
    expect(
      messages(
        withCondition(
          "1.1",
          "first.n > vars.threshhold",
          "vars:\n  threshold: { type: number, default: 1 }\n",
        ),
      ).join(" "),
    ).toMatch(/vars\.threshhold is not declared in vars \(declared: threshold\)/);
    expect(messages(withCondition("1.1", "first.n > vars.x")).join(" ")).toMatch(
      /there is no vars block/,
    );
  });

  it("does not mistake a name inside a filter, a lambda or a .(…) step for a read of the root", () => {
    expect(messages(withCondition("1.1", "$count(trigger.items[price > 3]) > 0"))).toEqual([]);
    expect(
      messages(withCondition("1.1", "$count($map(trigger.files, function($f){ $f.path })) > 0")),
    ).toEqual([]);
    expect(messages(withCondition("1.1", "$sum(trigger.items.(price * qty)) > 0"))).toEqual([]);
  });

  it("checks {{ expressions }} in tool fields and step messages as well, with the path of the field", () => {
    const source = `version: "1.1"
agent:
  id: a
  name: A
  role: R
  goal: G
  tools:
    - name: t
      action: http_request
      method: GET
      url: "https://x.test/{{ trigger.id }}/{{ oops. }}"
  workflow:
    - step: ask
      type: approval
      message: "Approve {{ nonsuch.x }}?"
`;
    const errors = parseSpec(source).errors;
    expect(errors.map((e) => e.path)).toEqual([
      ["agent", "workflow", 0, "message"],
      ["agent", "tools", 0, "url"],
    ]);
    expect(errors[0]!.message).toContain('"nonsuch" is not something an expression can read');
    expect(errors[1]!.message).toContain("{{ oops. }}");
  });

  it("refuses a step named trigger, input or vars, which an expression's roots would hide", () => {
    for (const name of ["trigger", "input", "vars"]) {
      const source = `version: "1.1"
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: ${name}
      action: x
`;
      expect(messages(source).join(" "), name).toContain(
        `"${name}" is a reserved name in a version "1.1" spec`,
      );
      // ...but it is fine in a 1.0 spec, which has no such roots.
      expect(parseSpec(source.replace('"1.1"', '"1.0"')).success, name).toBe(true);
    }
  });

  it("does not look at {{ }} in a 1.0 spec, which the original syntax handles", () => {
    expect(
      messages(
        withCondition("1.0", "first.ok == true").replace(
          "https://x.test/",
          "https://x.test/{{ not an expression",
        ),
      ),
    ).toEqual([]);
  });
});

describe("expressions, harder cases", () => {
  const tool = (url: string) => `version: "1.1"
agent:
  id: a
  name: A
  role: R
  goal: G
  tools:
    - name: t
      action: http_request
      method: GET
      url: ${JSON.stringify(url)}
  workflow:
    - step: first
      action: classify
`;

  it("loads a valid expression that contains }} (a nested constructor, a string)", () => {
    expect(messages(tool("https://x.test/{{ {'a':{'b':1}}.a }}"))).toEqual([]);
    expect(messages(tool("https://x.test/{{ 'a}}b' }}"))).toEqual([]);
  });

  it("accepts a transform, whose names are relative to the piped value", () => {
    expect(messages(tool("https://x.test/{{ trigger ~> | items | {'x': 1} | }}"))).toEqual([]);
  });

  it("tells the author to use backticks when a step name is not a plain identifier", () => {
    const source = `version: "1.1"
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: fetch-data
      action: fetch
    - step: decide
      type: condition
      if: "fetch-data.ok = true"
      then: "request_human_approval"
      else: "request_human_approval"
`;
    expect(messages(source).join(" ")).toMatch(/must be written in backticks: `fetch-data`\.field/);
    expect(messages(source.replace('"fetch-data.ok = true"', '"`fetch-data`.ok = true"'))).toEqual(
      [],
    );
  });

  it("says which line of a multi-line field the expression is on", () => {
    const source = `version: "1.1"
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: ask
      type: approval
      message: |
        Line one is fine.
        Approve {{ nonsuch.x }}?
`;
    const [error] = parseSpec(source).errors;
    expect(error!.message).toContain("[line 2 of the field]");
    // The position is where the field starts; the message says the line within it.
    expect(error!.line).toBe(10);
  });
});

describe("legacy syntax (version 1.0)", () => {
  it("notes the 1.0 condition grammar and single-brace placeholders, and still runs", () => {
    const parsed = parseSpec(VALID_FIXTURE_WITH_CONDITION);
    expect(parsed.success).toBe(true);
    const warnings = specWarnings(parsed.spec!);
    expect(warnings.map((w) => [w.code, w.path.join(".")])).toEqual([
      ["legacy_condition_syntax", "agent.workflow.2.if"],
      ["legacy_placeholder_syntax", "agent.tools.0.url"],
    ]);
    expect(warnings[0]!.message).toMatch(/keeps working/);
  });

  it("gives one note per kind however many there are, naming each place", () => {
    const source = `version: "1.0"
agent:
  id: a
  name: A
  role: R
  goal: G
  tools:
    - name: t
      action: http_request
      method: GET
      url: "https://x.test/{a.b}/{c}"
      headers: { "X-Y": "{d.e}" }
  workflow:
    - step: s1
      action: x
    - step: c1
      type: condition
      if: "s1.ok == true"
      then: "request_human_approval"
      else: "request_human_approval"
    - step: c2
      type: condition
      if: "s1.n > 3"
      then: "request_human_approval"
      else: "request_human_approval"
`;
    const warnings = specWarnings(parseSpec(source).spec!);
    expect(warnings.map((w) => w.code)).toEqual([
      "legacy_condition_syntax",
      "legacy_placeholder_syntax",
    ]);
    expect(warnings[0]!.message).toContain('Conditions "c1", "c2" use');
    expect(warnings[1]!.message).toMatch(/agent\.tools\.0\.url/);
  });

  it("does not warn about {{ step.field }}, which is valid in both versions, nor about a 1.1 spec", () => {
    const v10 = parseSpec(
      withCondition("1.0", "first.ok == true").replace(
        "https://x.test/",
        "https://x.test/{{ first.id }}",
      ),
    );
    expect(specWarnings(v10.spec!).map((w) => w.code)).toEqual(["legacy_condition_syntax"]);
    expect(specWarnings(parseSpec(VALID_FIXTURE_V1_1).spec!)).toEqual([]);
  });
});

describe("round trip (version 1.1)", () => {
  it("re-serializes a 1.1 spec with vars and expressions byte for byte", () => {
    const { doc, success } = parseSpec(VALID_FIXTURE_V1_1);
    expect(success).toBe(true);
    expect(toYamlString(doc)).toBe(VALID_FIXTURE_V1_1);
  });

  it("adds a var through a canvas patch without disturbing comments or the rest", () => {
    const { doc } = parseSpec(VALID_FIXTURE_V1_1);
    applyPatch(doc, [
      { op: "set", path: ["vars", "limit"], value: { type: "number", default: 10 } },
    ]);
    const output = toYamlString(doc);
    expect(output).toContain("# Incident responder (version 1.1: expressions and vars)");
    const reparsed = parseSpec(output);
    expect(reparsed.success).toBe(true);
    expect(Object.keys(reparsed.spec!.vars!)).toEqual(["threshold", "region", "tickers", "limit"]);
  });

  it("edits a condition's expression in place", () => {
    const { doc } = parseSpec(VALID_FIXTURE_V1_1);
    applyPatch(doc, [
      { op: "set", path: ["agent", "workflow", 1, "if"], value: "vars.threshold > 1" },
    ]);
    const reparsed = parseSpec(toYamlString(doc));
    expect(reparsed.success).toBe(true);
  });
});
