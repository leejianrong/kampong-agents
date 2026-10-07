import { describe, expect, it } from "vitest";
import { parseSpec, toYamlString } from "../../src/parse.js";

// KAN-1843 (ADR-0038): an action step's `output_schema`.

const spec = (version: string, step: string) => `version: "${version}"
agent:
  id: a
  name: A
  role: R
  goal: G
  guardrails:
    confidence_threshold: 0.8
    fallback_action: escalate_to_human
  workflow:
    - step: triage
      action: classify
${step}`;

const OBJECT = `      output_schema:
        type: object
        required: [severity, confidence]
        properties:
          severity: {type: string, enum: [low, high], description: How bad}
          confidence: {type: number, minimum: 0, maximum: 1}
          tags: {type: array, items: {type: string}}
`;
const messages = (source: string) => parseSpec(source).errors.map((e) => e.message);

describe("output_schema on an action step", () => {
  it("is accepted in 1.1 and survives a parse/serialize round trip", () => {
    const source = spec("1.1", OBJECT);
    const result = parseSpec(source);
    expect(result.errors).toEqual([]);
    expect(toYamlString(result.doc)).toBe(source);
    const step = result.spec!.agent.workflow[0] as { output_schema?: { required?: string[] } };
    expect(step.output_schema?.required).toEqual(["severity", "confidence"]);
  });

  it("needs version 1.1", () => {
    expect(messages(spec("1.0", OBJECT))).toEqual(['output_schema needs version "1.1"']);
  });

  it("must describe an object", () => {
    expect(messages(spec("1.1", "      output_schema: { type: string }\n"))).toEqual([
      'output_schema must describe an object (type: "object")',
    ]);
  });

  it("rejects keywords outside the supported subset", () => {
    const bad = "      output_schema: { type: object, oneOf: [] }\n";
    expect(parseSpec(spec("1.1", bad)).success).toBe(false);
  });

  it("with confidence_gate, requires a numeric confidence property", () => {
    const gated = (schema: string) => spec("1.1", `      confidence_gate: true\n${schema}`);
    expect(parseSpec(gated(OBJECT)).errors).toEqual([]);
    const without =
      "      output_schema: { type: object, properties: { severity: { type: string } } }\n";
    expect(messages(gated(without))).toEqual([
      'a confidence_gate step with an output_schema must declare a numeric "confidence" property (0 to 1) that is required and has no default',
    ]);
    const wrongType =
      "      output_schema: { type: object, properties: { confidence: { type: string } } }\n";
    expect(messages(gated(wrongType))).toHaveLength(1);
    // Declared but optional, or defaulted, would let a missing value pass the guardrail as full confidence.
    const optional =
      "      output_schema: { type: object, properties: { confidence: { type: number } } }\n";
    expect(messages(gated(optional))).toHaveLength(1);
    const defaulted =
      "      output_schema: { type: object, required: [confidence], properties: { confidence: { type: number, default: 1 } } }\n";
    expect(messages(gated(defaulted))).toHaveLength(1);
  });
});
