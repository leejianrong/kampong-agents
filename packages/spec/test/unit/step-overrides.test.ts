import { describe, expect, it } from "vitest";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { buildWorkflowStepFromForm } from "../../src/workflow-form.js";

// KAN-1842: an action step's `instructions`, `model` and `temperature`.

const spec = (version: string, fields: string) => `version: "${version}"
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: draft
      action: write
${fields}`;

const FIELDS = `      instructions: Answer as a support agent.
      model: gpt-4o-mini
      temperature: 0.2
`;
const messages = (source: string) => parseSpec(source).errors.map((e) => e.message);

describe("per-step instructions, model and temperature", () => {
  it("are accepted in 1.1 and survive a parse/serialize round trip", () => {
    const source = spec("1.1", FIELDS);
    const result = parseSpec(source);
    expect(result.errors).toEqual([]);
    expect(toYamlString(result.doc)).toBe(source);
  });

  it("are refused in a 1.0 spec, one message per field", () => {
    expect(messages(spec("1.0", FIELDS))).toEqual([
      'instructions needs version "1.1"',
      'model needs version "1.1"',
      'temperature needs version "1.1"',
    ]);
  });

  it("reject an out-of-range temperature and empty strings", () => {
    expect(messages(spec("1.1", "      temperature: 3\n")).length).toBe(1);
    expect(messages(spec("1.1", '      model: ""\n')).length).toBe(1);
    expect(messages(spec("1.1", '      instructions: ""\n')).length).toBe(1);
  });

  it("are built by the canvas form builder, and blank ones are left out", () => {
    const built = buildWorkflowStepFromForm({
      step: "draft",
      action: "write",
      instructions: "Be brief.",
      model: "",
      temperature: 0,
    });
    expect(built.step).toEqual({
      step: "draft",
      action: "write",
      instructions: "Be brief.",
      temperature: 0,
    });
  });
});
