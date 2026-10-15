import { describe, expect, it } from "vitest";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { applyPatch } from "../../src/mutate.js";
import {
  buildVarFromForm,
  removeVarPatch,
  setVarPatch,
  varToFormInput,
  type VarFormInput,
} from "../../src/vars-form.js";

// KAM-159: the Spec vars panel's form logic.

const build = (input: Partial<VarFormInput> & { name: string }, existing: string[] = []) =>
  buildVarFromForm({ type: "string", ...input }, existing);
const errors = (input: Partial<VarFormInput> & { name: string }, existing: string[] = []) => {
  const r = build(input, existing);
  return r.success ? [] : r.errors;
};

describe("buildVarFromForm", () => {
  it("builds each type, with and without a default", () => {
    expect(build({ name: "channel", default: "#alerts", description: "Where to post" })).toEqual({
      success: true,
      name: "channel",
      value: { type: "string", description: "Where to post", default: "#alerts" },
    });
    expect(build({ name: "threshold", type: "number", default: "1.5" })).toMatchObject({
      value: { type: "number", default: 1.5 },
    });
    expect(build({ name: "symbols", type: "list", default: "AAPL, MSFT ,NVDA" })).toMatchObject({
      value: { type: "list", default: ["AAPL", "MSFT", "NVDA"] },
    });
    expect(build({ name: "required_one" })).toEqual({
      success: true,
      name: "required_one",
      value: { type: "string" },
    });
  });

  it("reads a list as JSON or comma-separated, as numbers when items is number", () => {
    expect(build({ name: "a", type: "list", default: '["x", "y,z"]' })).toMatchObject({
      value: { default: ["x", "y,z"] },
    });
    expect(build({ name: "a", type: "list", items: "number", default: "1, 2.5" })).toMatchObject({
      value: { type: "list", items: "number", default: [1, 2.5] },
    });
    expect(build({ name: "a", type: "list", items: "string" })).toMatchObject({
      value: { type: "list" },
    });
    expect(build({ name: "a", type: "list", items: "string" })).not.toHaveProperty("value.items");
  });

  it("keeps ${ENV} as text whatever the type", () => {
    for (const type of ["string", "number", "list"] as const) {
      expect(build({ name: "a", type, default: "${SYMBOLS}" })).toMatchObject({
        value: { default: "${SYMBOLS}" },
      });
    }
  });

  it("explains a default that does not fit", () => {
    expect(errors({ name: "a", type: "number", default: "lots" })).toEqual([
      expect.stringContaining('"lots" is not a number'),
    ]);
    expect(errors({ name: "a", type: "list", items: "number", default: "1, two" })).toEqual([
      expect.stringContaining('item 2 ("two") is not a number'),
    ]);
    expect(errors({ name: "a", type: "list", default: "[1," })).toEqual([
      expect.stringContaining("not a JSON list"),
    ]);
  });

  it("refuses a bad or duplicate name", () => {
    expect(errors({ name: "" })).toEqual(["A var needs a name"]);
    expect(errors({ name: "1st" })[0]).toMatch(/not a valid var name/);
    expect(errors({ name: "has space" })[0]).toMatch(/not a valid var name/);
    // Read as vars.trigger, so it clashes with nothing and the schema allows it.
    expect(errors({ name: "trigger" })).toEqual([]);
    expect(errors({ name: "symbols" }, ["symbols"])).toEqual([
      'a var named "symbols" already exists',
    ]);
  });

  it("agrees with the spec loader: a built var always validates", () => {
    const built = build({ name: "n", type: "list", items: "number", default: "1,2" });
    if (!built.success) throw new Error("expected success");
    const source = `version: "1.1"
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: s
      action: write
`;
    const { doc } = parseSpec(source);
    applyPatch(doc, setVarPatch(built.name, built.value));
    expect(parseSpec(toYamlString(doc)).errors).toEqual([]);
  });
});

describe("varToFormInput", () => {
  it("turns a var back into the form's text", () => {
    expect(varToFormInput("symbols", { type: "list", items: "number", default: [1, 2] })).toEqual({
      name: "symbols",
      type: "list",
      items: "number",
      default: "1, 2",
    });
    expect(varToFormInput("t", { type: "number", description: "d", default: 0 })).toEqual({
      name: "t",
      type: "number",
      description: "d",
      default: "0",
    });
  });

  it("round-trips through the builder", () => {
    for (const [name, value] of Object.entries({
      a: { type: "string", default: "x", description: "d" },
      b: { type: "number", default: 2.5 },
      c: { type: "list", items: "number", default: [1, 2] },
      d: { type: "list", default: ["x", "y"] },
    } as const)) {
      const form = varToFormInput(name, value as never);
      expect(buildVarFromForm(form)).toEqual({ success: true, name, value });
    }
  });
});

describe("patches", () => {
  const source = `# my agent
version: "1.1"
vars:
  # untouched
  keep:
    type: string
    default: x
  other:
    type: number
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: s
      action: write
`;
  const apply = (text: string, ...ops: Parameters<typeof applyPatch>[1][]) => {
    const { doc } = parseSpec(text);
    for (const o of ops) applyPatch(doc, o);
    return toYamlString(doc);
  };

  it("adds and replaces a var without touching the rest of the file", () => {
    const added = apply(source, setVarPatch("fresh", { type: "number", default: 3 }));
    expect(added).toBe(
      source.replace("agent:\n  id", "  fresh:\n    type: number\n    default: 3\nagent:\n  id"),
    );
    const replaced = apply(source, setVarPatch("other", { type: "string" }));
    expect(replaced).toBe(source.replace("other:\n    type: number", "other:\n    type: string"));
  });

  it("removes a var, and the whole vars block with the last one", () => {
    expect(apply(source, removeVarPatch("other", 2))).toBe(
      source.replace("  other:\n    type: number\n", ""),
    );
    const one = source.replace("  other:\n    type: number\n", "");
    // The comment above the removed var goes with it.
    expect(apply(one, removeVarPatch("keep", 1))).toBe(
      source.replace(/vars:[\s\S]*?(?=agent:)/, ""),
    );
  });

  it("puts a first var above agent:, where hand-written specs keep it", () => {
    const bare = source.replace(/vars:[\s\S]*?(?=agent:)/, "");
    const out = apply(bare, setVarPatch("first", { type: "string" }, 0));
    expect(out.indexOf("vars:")).toBeGreaterThan(out.indexOf("version:"));
    expect(out.indexOf("vars:")).toBeLessThan(out.indexOf("agent:"));
    expect(out).toContain("# my agent\n");
  });
});
