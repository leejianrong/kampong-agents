import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/parse.js";
import { specWarnings } from "../../src/warnings.js";

// KAN-1831 (V11-X): `knowledge_base` is declared in the schema but no engine path reads it, so a
// spec that declares it must say so visibly instead of silently ignoring it.

const BASE = `version: "1.0"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  workflow:
    - step: greet
      action: say_hello
`;

function specFrom(source: string) {
  const { spec } = parseSpec(source);
  if (!spec) throw new Error("fixture should be a valid spec");
  return spec;
}

describe("specWarnings", () => {
  it("returns no warnings for a spec that declares nothing inert", () => {
    expect(specWarnings(specFrom(BASE))).toEqual([]);
  });

  it("warns when knowledge_base is declared, because nothing executes it", () => {
    const source = BASE.replace(
      "  workflow:",
      '  knowledge_base:\n    - type: url\n      source: "https://docs.example.com/policy"\n  workflow:',
    );

    const warnings = specWarnings(specFrom(source));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "knowledge_base_not_executed",
      path: ["agent", "knowledge_base"],
    });
    expect(warnings[0]?.message).toMatch(/not (yet )?executed/i);
  });

  it("does not warn for an empty knowledge_base list", () => {
    const source = BASE.replace("  workflow:", "  knowledge_base: []\n  workflow:");

    expect(specWarnings(specFrom(source))).toEqual([]);
  });
});
