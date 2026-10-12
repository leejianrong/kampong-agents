import { describe, expect, it } from "vitest";
import { applyPatch } from "../../src/mutate.js";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { generateAgentSpecJsonSchema } from "../../src/json-schema.js";
import { VALID_FIXTURE_FOREACH } from "../fixtures-foreach.js";

// KAN-1858 (ADR-0043): the `foreach` step, version 1.1 only.

const specWith = (version: string, loop: string) => `version: "${version}"
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
    - name: risky
      action: http_request
      method: POST
      url: "https://x.example/"
      requires_approval: true
  workflow:
    - step: first
      action: fetch
${loop}`;

// A loop `each` whose single body step `inner` is `inner` (indented 10), with extra foreach fields in `head`.
const loop = (inner = "            action: do_it\n", head = "") =>
  `    - step: each\n      foreach:\n        items: "trigger.list"\n        as: item\n${head}        steps:\n          - step: inner\n${inner}`;

const errorsOf = (source: string) => parseSpec(source).errors;

describe("foreach: fixture", () => {
  it("parses and re-serializes byte-for-byte", () => {
    const r = parseSpec(VALID_FIXTURE_FOREACH);
    expect(r.errors).toEqual([]);
    expect(toYamlString(r.doc)).toBe(VALID_FIXTURE_FOREACH);
  });

  it("a canvas mutation of a nested field touches one line only", () => {
    const { doc } = parseSpec(VALID_FIXTURE_FOREACH);
    applyPatch(doc, [
      { op: "set", path: ["agent", "workflow", 0, "foreach", "concurrency"], value: 4 },
    ]);
    const out = toYamlString(doc);
    expect(out).toContain("# Per-symbol price loop");
    const before = VALID_FIXTURE_FOREACH.split("\n");
    expect(out.split("\n").filter((l, i) => l !== before[i])).toHaveLength(1);
    expect(parseSpec(out).errors).toEqual([]);
  });

  it("is in the published JSON Schema", () => {
    expect(JSON.stringify(generateAgentSpecJsonSchema())).toContain('"foreach"');
  });
});

describe("foreach: shape", () => {
  it("accepts the minimal form and every on_error spelling", () => {
    expect(errorsOf(specWith("1.1", loop()))).toEqual([]);
    for (const policy of ["fail", "continue"]) {
      expect(errorsOf(specWith("1.1", loop(undefined, `        on_error: ${policy}\n`)))).toEqual(
        [],
      );
    }
    expect(
      errorsOf(
        specWith("1.1", loop(undefined, "        on_error:\n          retry:\n            n: 3\n")),
      ),
    ).toEqual([]);
  });

  it("needs version 1.1, at the line of the foreach body", () => {
    const errors = errorsOf(specWith("1.0", loop()));
    expect(errors.map((e) => e.message)).toEqual(['foreach needs version "1.1"']);
    expect(errors[0]!.line).toBe(22);
  });

  it("refuses a bad concurrency, an unknown on_error and an unknown field", () => {
    expect(errorsOf(specWith("1.1", loop(undefined, "        concurrency: 0\n"))).length).toBe(1);
    expect(errorsOf(specWith("1.1", loop(undefined, "        on_error: shrug\n"))).length).toBe(1);
    expect(errorsOf(specWith("1.1", loop(undefined, "        parallel: 3\n"))).length).toBe(1);
    expect(
      errorsOf(
        specWith("1.1", loop(undefined, "        on_error:\n          retry:\n            n: 0\n")),
      ).length,
    ).toBe(1);
  });

  it("refuses an empty steps list", () => {
    const e = errorsOf(
      specWith(
        "1.1",
        `    - step: each\n      foreach:\n        items: "x"\n        as: i\n        steps: []\n`,
      ),
    );
    expect(e.length).toBe(1);
  });

  it("rejects goto as not yet supported, at the field's line", () => {
    const inline = errorsOf(specWith("1.1", loop(undefined, "        on_error: goto\n")));
    expect(inline).toHaveLength(1);
    expect(inline[0]!.message).toMatch(/goto is not supported.*branch step/);
    expect(inline[0]!.line).toBe(24);
    const map = errorsOf(
      specWith("1.1", loop(undefined, "        on_error:\n          goto: first\n")),
    );
    expect(map).toHaveLength(1);
    expect(map[0]!.message).toMatch(/goto is not supported.*branch step/);
    expect(map[0]!.line).toBe(25);
  });
});

describe("foreach: nesting and approvals", () => {
  it("rejects a foreach inside a foreach, at its line", () => {
    const errors = errorsOf(
      specWith(
        "1.1",
        `    - step: each
      foreach:
        items: "x"
        as: i
        steps:
          - step: deep
            foreach:
              items: "i.kids"
              as: j
              steps:
                - step: z
                  action: z
`,
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/foreach inside a foreach is not supported yet/);
    expect(errors[0]!.line).toBe(27);
  });

  it("rejects an approval step, a request_human_approval branch and an approval-gated tool in a body", () => {
    const approval = errorsOf(specWith("1.1", loop("            type: approval\n")));
    expect(approval[0]!.message).toMatch(/approval.*not supported inside a foreach/);
    const branch = errorsOf(
      specWith(
        "1.1",
        loop(
          '            type: condition\n            if: "item = 1"\n            then: request_human_approval\n            else: "execute_tool(t)"\n',
        ),
      ),
    );
    expect(branch[0]!.message).toMatch(/approval.*not supported inside a foreach/);
    expect(branch[0]!.line).toBe(28);
    const tool = errorsOf(
      specWith("1.1", loop("            type: tool\n            tool: risky\n")),
    );
    expect(tool[0]!.message).toMatch(/requires approval.*not supported inside a foreach/);
  });
});

describe("foreach: names and expressions", () => {
  it("reads the loop variable and earlier body steps in the body, but not outside the loop", () => {
    const ok = errorsOf(
      specWith(
        "1.1",
        `    - step: each
      foreach:
        items: "first.rows"
        as: row
        steps:
          - step: a
            type: transform
            set:
              id: "row.id"
          - step: b
            type: transform
            set:
              again: "a.id & row.id"
`,
      ),
    );
    expect(ok).toEqual([]);
    const outside = errorsOf(
      specWith(
        "1.1",
        `    - step: each
      foreach:
        items: "first.rows"
        as: row
        steps:
          - step: a
            action: x
    - step: after
      type: transform
      set:
        bad: "row.id"
`,
      ),
    );
    expect(outside[0]!.message).toMatch(/"row" is not something an expression can read/);
    expect(outside[0]!.line).toBe(30);
  });

  it("does not let items read the loop variable, and checks expressions in nested steps", () => {
    const e = errorsOf(
      specWith(
        "1.1",
        `    - step: each
      foreach:
        items: "row.children"
        as: row
        steps:
          - step: a
            type: validate
            assert: "nope.x = 1"
`,
      ),
    );
    expect(e.map((x) => x.line)).toEqual([22, 27]);
  });

  it("rejects an as name that is reserved or a step name, and a duplicate body step", () => {
    const reserved = errorsOf(specWith("1.1", loop().replace("as: item", "as: trigger")));
    expect(reserved[0]!.message).toMatch(/"trigger" cannot be used as/);
    const clash = errorsOf(specWith("1.1", loop().replace("as: item", "as: first")));
    expect(clash[0]!.message).toMatch(/"first" cannot be used as/);
    const bad = errorsOf(specWith("1.1", loop().replace("as: item", "as: 'a-b'")));
    expect(bad[0]!.message).toMatch(/not a valid name/);
    const dup = errorsOf(
      specWith(
        "1.1",
        `    - step: each\n      foreach:\n        items: "x"\n        as: i\n        steps:\n          - step: a\n            action: x\n          - step: a\n            action: y\n`,
      ),
    );
    expect(dup[0]!.message).toMatch(/duplicate step name "a"/);
  });

  it("applies the 1.1-only checks to nested steps", () => {
    const e = errorsOf(
      specWith("1.1", loop("            action: x\n            temperature: 9\n")),
    );
    expect(e.length).toBeGreaterThan(0);
  });

  it("checks a nested transform's names", () => {
    const e = errorsOf(
      specWith(
        "1.1",
        loop("            type: transform\n            set:\n              'a-b': '1'\n"),
      ),
    );
    expect(e[0]!.message).toMatch(/"a-b" is not a valid name/);
  });
});
