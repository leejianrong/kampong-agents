import { describe, expect, it } from "vitest";
import {
  blankSpecSource,
  hasEmptyWorkflow,
  hasPragma,
  isBlankSource,
  parseSpec,
} from "../../src/index.js";

describe("blankSpecSource (KAM-196)", () => {
  it("validates, starts with the schema pragma, and uses the options given", () => {
    const source = blankSpecSource({ id: "my_flow", name: "My flow", schemaPath: "./s.json" });
    expect(source.split("\n")[0]).toBe("# yaml-language-server: $schema=./s.json");
    expect(hasPragma(source)).toBe(true);
    const result = parseSpec(source);
    expect(result.errors).toEqual([]);
    expect(result.spec?.agent.id).toBe("my_flow");
    expect(result.spec?.agent.name).toBe("My flow");
  });

  it("validates with the defaults", () => {
    expect(parseSpec(blankSpecSource()).success).toBe(true);
  });
});

describe("empty-state detection (KAM-196)", () => {
  it("treats whitespace as a blank source", () => {
    expect(isBlankSource("")).toBe(true);
    expect(isBlankSource(" \n\t")).toBe(true);
    expect(isBlankSource("version: '1.0'")).toBe(false);
  });

  it("finds an empty workflow, and only that", () => {
    const head = 'version: "1.0"\nagent:\n  id: a\n  name: A\n  role: r\n  goal: g\n';
    expect(hasEmptyWorkflow(`${head}  workflow: []\n`)).toBe(true);
    expect(hasEmptyWorkflow(`${head}  workflow:\n`)).toBe(true);
    expect(hasEmptyWorkflow(`${head}  workflow:\n    - step: s\n      action: a\n`)).toBe(false);
    expect(hasEmptyWorkflow(head)).toBe(false);
    expect(hasEmptyWorkflow("agent: [unclosed")).toBe(false);
    expect(hasEmptyWorkflow("")).toBe(false);
  });
});
