import { describe, expect, it } from "vitest";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { expressionScopeFor } from "../../src/expression-assist.js";
import { applyPatch } from "../../src/mutate.js";
import {
  actionStepToEditInput,
  buildActionStepEdit,
  buildDataStepEdit,
  dataStepToEditInput,
  type DataStepEditInput,
  buildOutputSchema,
  emptySchemaDraft,
  listSteps,
  schemaToDraft,
  type ActionStepEditInput,
  type SchemaDraft,
} from "../../src/step-edit.js";

// KAM-162: editing an existing step from the canvas.

const SOURCE = `# a spec
version: "1.1"
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: classify
      action: classify
      confidence_gate: false
      temperature: 0.2 # keep it steady
    - step: each
      foreach:
        items: trigger.items
        as: item
        steps:
          - step: inner
            action: summarise
    - step: pick
      branch:
        if: "true"
        then:
          - step: yes
            action: say
        else:
          - step: no
            action: say
    - step: sw
      branch:
        switch: trigger.kind
        cases:
          a:
            - step: in_case
              action: say
        default:
          - step: in_default
            action: say
`;

const load = () => {
  const { doc, spec, errors } = parseSpec(SOURCE);
  expect(errors).toEqual([]);
  return { doc, spec: spec! };
};

describe("listSteps", () => {
  it("lists every step with its path, kind and parents", () => {
    const refs = listSteps(load().spec);
    expect(refs.map((r) => [r.name, r.kind, r.within.join("/")])).toEqual([
      ["classify", "action", ""],
      ["each", "foreach", ""],
      ["inner", "action", "each"],
      ["pick", "branch", ""],
      ["yes", "action", "pick"],
      ["no", "action", "pick"],
      ["sw", "branch", ""],
      ["in_case", "action", "sw"],
      ["in_default", "action", "sw"],
    ]);
  });

  it("gives paths that address the step in the document", () => {
    const { doc, spec } = load();
    for (const ref of listSteps(spec)) {
      expect(doc.getIn([...ref.path, "step"])).toBe(ref.name);
    }
  });
});

const obj = (props: [string, SchemaDraft, boolean?][]): SchemaDraft => ({
  ...emptySchemaDraft("object"),
  properties: props.map(([name, draft, required]) => ({
    name,
    draft,
    required: required ?? false,
  })),
});
const str = (description = "", enumText = ""): SchemaDraft => ({
  ...emptySchemaDraft("string"),
  description,
  enum: enumText,
});

describe("buildOutputSchema", () => {
  it("builds nested objects, arrays, enums and required", () => {
    const r = buildOutputSchema(
      obj([
        ["label", str("The class", "spam, ham"), true],
        ["score", emptySchemaDraft("number")],
        ["tags", { ...emptySchemaDraft("array"), items: str() }],
        ["detail", obj([["why", str()]])],
      ]),
    );
    expect(r).toEqual({
      success: true,
      value: {
        type: "object",
        properties: {
          label: { type: "string", description: "The class", enum: ["spam", "ham"] },
          score: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
          detail: { type: "object", properties: { why: { type: "string" } } },
        },
        required: ["label"],
      },
    });
  });

  it("reads enum values as the property's type", () => {
    const num = { ...emptySchemaDraft("integer"), enum: "1, 2" };
    expect(buildOutputSchema(obj([["n", num]]))).toMatchObject({
      value: { properties: { n: { enum: [1, 2] } } },
    });
    const bad = { ...emptySchemaDraft("integer"), enum: "1, two" };
    expect(buildOutputSchema(obj([["n", bad]]))).toEqual({
      success: false,
      errors: ['output_schema.n: enum value "two" is not a valid integer'],
    });
    expect(
      buildOutputSchema(obj([["b", { ...emptySchemaDraft("boolean"), enum: "true" }]])),
    ).toMatchObject({ value: { properties: { b: { enum: [true] } } } });
  });

  it("refuses what the loader refuses", () => {
    const errors = (d: SchemaDraft, gate = false) => {
      const r = buildOutputSchema(d, gate);
      return r.success ? [] : r.errors;
    };
    expect(errors(emptySchemaDraft("string"))).toEqual([
      'output_schema must describe an object (type: "object")',
    ]);
    expect(errors(obj([]))[0]).toMatch(/must list its properties/);
    expect(errors(obj([["inner", obj([])]]))[0]).toMatch(
      /output_schema\.inner: an object must list/,
    );
    expect(errors(obj([["a", emptySchemaDraft("array")]]))[0]).toMatch(/must declare its items/);
    expect(errors(obj([["1bad", str()]]))[0]).toMatch(/not a valid property name/);
    expect(
      errors(
        obj([
          ["a", str()],
          ["a", str()],
        ]),
      )[0],
    ).toMatch(/more than once/);
    expect(errors(obj([["a", str()]]), true)[0]).toMatch(/confidence_gate/);
    expect(errors(obj([["confidence", emptySchemaDraft("number"), true]]), true)).toEqual([]);
    expect(errors(obj([["confidence", emptySchemaDraft("number")]]), true)[0]).toMatch(
      /confidence_gate/,
    );
  });

  it("keeps keywords the form has no field for", () => {
    const node = {
      type: "object" as const,
      properties: { n: { type: "number" as const, minimum: 0, maximum: 1 } },
    };
    expect(buildOutputSchema(schemaToDraft(node))).toEqual({ success: true, value: node });
  });

  it("round-trips a schema through its draft", () => {
    const node = {
      type: "object" as const,
      description: "d",
      properties: {
        a: { type: "string" as const, enum: ["x", "y"] },
        b: {
          type: "array" as const,
          items: { type: "object" as const, properties: { c: { type: "boolean" as const } } },
        },
      },
      required: ["a"],
    };
    expect(buildOutputSchema(schemaToDraft(node))).toEqual({ success: true, value: node });
  });
});

describe("buildActionStepEdit", () => {
  const input = (change: Partial<ActionStepEditInput> = {}): ActionStepEditInput => ({
    instructions: "",
    model: "",
    temperature: "",
    ...change,
  });
  const target = (name: string) => listSteps(load().spec).find((r) => r.name === name)! as never;
  const apply = (name: string, edit: ActionStepEditInput, version = "1.1") => {
    const { doc } = load();
    const ref = target(name) as { path: (string | number)[]; step: never };
    const r = buildActionStepEdit(edit, ref, version);
    if (!r.success) return r;
    applyPatch(doc, r.patch);
    return { success: true as const, text: toYamlString(doc) };
  };

  it("sets instructions, model and temperature, and loads clean", () => {
    const r = apply(
      "classify",
      input({ instructions: "Be brief.", model: "gpt-x", temperature: "0.7" }),
    );
    expect(r.success).toBe(true);
    const text = (r as { text: string }).text;
    expect(parseSpec(text).errors).toEqual([]);
    expect(text).toContain("instructions: Be brief.");
    expect(text).toContain("model: gpt-x");
    expect(text).toContain("temperature: 0.7");
  });

  it("patches nothing when nothing changed, and the rest of the file stays", () => {
    const { spec } = load();
    const step = listSteps(spec)[0]!;
    const same = actionStepToEditInput(step.step as never);
    expect(buildActionStepEdit(same, step as never, "1.1")).toEqual({ success: true, patch: [] });
    const r = apply("classify", input({ temperature: "0.2", model: "m" })) as { text: string };
    expect(r.text.startsWith("# a spec\n")).toBe(true);
    expect(r.text).toContain("temperature: 0.2 # keep it steady");
  });

  it("clears a field when its box is emptied", () => {
    const r = apply("classify", input()) as { text: string };
    expect(r.text).not.toContain("temperature");
    expect(parseSpec(r.text).errors).toEqual([]);
  });

  it("edits a step inside a foreach, a branch arm and a switch case", () => {
    for (const name of ["inner", "yes", "no", "in_case", "in_default"]) {
      const r = apply(name, input({ model: "m2" })) as { text: string };
      expect(parseSpec(r.text).errors).toEqual([]);
      expect(r.text.match(/model: m2/g)).toHaveLength(1);
    }
  });

  it("sets an output_schema and loads clean", () => {
    const r = apply("inner", input({ schema: obj([["summary", str("One line"), true]]) })) as {
      text: string;
    };
    const parsed = parseSpec(r.text);
    expect(parsed.errors).toEqual([]);
    expect(r.text).toContain("output_schema:");
  });

  it("checks the temperature and the schema, and never patches on an error", () => {
    expect(apply("classify", input({ temperature: "3" }))).toEqual({
      success: false,
      errors: ['temperature "3" must be a number from 0 to 2'],
    });
    expect(apply("classify", input({ temperature: "warm" })).success).toBe(false);
    expect(apply("classify", input({ schema: obj([]) })).success).toBe(false);
  });

  it("needs version 1.1 for each field", () => {
    expect(
      apply(
        "classify",
        input({ instructions: "x", model: "m", temperature: "1", schema: obj([["a", str()]]) }),
        "1.0",
      ),
    ).toEqual({
      success: false,
      errors: [
        'instructions needs version "1.1"',
        'model needs version "1.1"',
        'temperature needs version "1.1"',
        'output_schema needs version "1.1"',
      ],
    });
  });
});

describe("data steps (KAM-152)", () => {
  const DATA = `# data
version: "1.1"
vars:
  limit:
    type: number
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: fetch
      action: fetch
    - step: shape
      type: transform
      set:
        # the title
        title: fetch.title
        n: vars.limit
    - step: check
      type: validate
      assert: $exists(shape.title)
      on_fail: skip
      message: no title
    - step: once
      type: dedupe
      once:
        key: shape.title
        ttl: 24h
`;
  const loadData = () => {
    const { doc, spec, errors } = parseSpec(DATA);
    expect(errors).toEqual([]);
    return { doc, spec: spec! };
  };
  const run = (
    name: string,
    change: (i: DataStepEditInput) => DataStepEditInput,
    version = "1.1",
  ) => {
    const { doc, spec } = loadData();
    const ref = listSteps(spec).find((r) => r.name === name)!;
    const input = change(dataStepToEditInput(ref.step as never));
    const r = buildDataStepEdit(
      input,
      ref as never,
      version,
      expressionScopeFor(spec, { before: name }),
    );
    if (!r.success) return r;
    applyPatch(doc, r.patch);
    return { success: true as const, patch: r.patch, text: toYamlString(doc) };
  };

  it("turns each step into form text and back to no change", () => {
    const { spec } = loadData();
    for (const ref of listSteps(spec).filter((r) =>
      ["transform", "validate", "dedupe"].includes(r.kind),
    )) {
      const input = dataStepToEditInput(ref.step as never);
      expect(buildDataStepEdit(input, ref as never, "1.1")).toEqual({ success: true, patch: [] });
    }
    expect(dataStepToEditInput(listSteps(spec)[1]!.step as never)).toEqual({
      kind: "transform",
      set: "title: fetch.title\nn: vars.limit",
    });
  });

  it("edits a transform's values and loads clean", () => {
    const r = run(
      "shape",
      (i) => ({ ...i, set: "title: fetch.title\nlimit: vars.limit * 2" }) as never,
    );
    expect(r.success).toBe(true);
    const text = (r as { text: string }).text;
    expect(parseSpec(text).errors).toEqual([]);
    expect(text).toContain("limit: vars.limit * 2");
    expect(text.startsWith("# data\n")).toBe(true);
  });

  it("edits validate and dedupe fields, and clears the message", () => {
    const v = run(
      "check",
      (i) => ({ ...i, assert: "$exists(shape.n)", onFail: "fail", message: "" }) as never,
    );
    const vt = (v as { text: string }).text;
    expect(parseSpec(vt).errors).toEqual([]);
    expect(vt).toContain("assert: $exists(shape.n)");
    expect(vt).toContain("on_fail: fail");
    expect(vt).not.toContain("no title");
    const d = run("once", (i) => ({ ...i, key: "shape.n", ttl: "1d" }) as never);
    const dt = (d as { text: string }).text;
    expect(parseSpec(dt).errors).toEqual([]);
    expect(dt).toContain("key: shape.n");
    expect(dt).toContain("ttl: 1d");
  });

  it("refuses what the loader refuses: syntax, unknown names, ttl, blanks", () => {
    const errs = (name: string, change: (i: DataStepEditInput) => unknown) => {
      const r = run(name, change as never);
      return r.success ? [] : r.errors;
    };
    expect(errs("shape", (i) => ({ ...i, set: "a: (" }))[0]).toMatch(/^a: /);
    expect(errs("shape", (i) => ({ ...i, set: "a: nosuch.x" }))[0]).toMatch(
      /not something an expression can read/,
    );
    expect(errs("shape", (i) => ({ ...i, set: "a: vars.nope" }))[0]).toMatch(
      /vars.nope is not declared/,
    );
    expect(errs("shape", (i) => ({ ...i, set: "" }))[0]).toMatch(/at least one value/);
    expect(errs("check", (i) => ({ ...i, assert: "" }))).toEqual([
      "A validate step needs an assertion",
    ]);
    expect(errs("check", (i) => ({ ...i, assert: "a =" }))[0]).toMatch(/^assert: /);
    expect(errs("once", (i) => ({ ...i, ttl: "soon" }))[0]).toMatch(/^ttl: /);
    expect(errs("once", (i) => ({ ...i, key: "" }))).toEqual([
      "A dedupe step needs a key expression",
    ]);
  });

  it("needs version 1.1", () => {
    expect(run("check", (i) => i, "1.0")).toEqual({
      success: false,
      errors: ['a validate step needs version "1.1"'],
    });
  });
});
