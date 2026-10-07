import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SchemaNode } from "@kampong/spec";
import { schemaNodeToZod } from "../../src/output-zod.js";

// KAN-1843 regression, found against a real model: the first version gave the provider an open object
// (z.record), which becomes `propertyNames` in JSON Schema and which OpenAI's strict structured output
// rejects with a 400 ("'propertyNames' is not permitted"). The provider must get the real structure.

const node: SchemaNode = {
  type: "object",
  required: ["severity", "confidence"],
  properties: {
    severity: { type: "string", enum: ["low", "high"], description: "How bad" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    count: { type: "integer" },
    ok: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
    nested: {
      type: "object",
      required: ["a"],
      properties: { a: { type: "string", maxLength: 3 } },
    },
  },
};

const json = (n: SchemaNode) =>
  z.toJSONSchema(schemaNodeToZod(n), { target: "draft-07" }) as Record<string, unknown>;

describe("schemaNodeToZod", () => {
  it("describes the structure, never an open object", () => {
    const schema = json(node);
    expect(JSON.stringify(schema)).not.toContain("propertyNames");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["severity", "confidence"]);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.severity).toMatchObject({
      type: "string",
      enum: ["low", "high"],
      description: "How bad",
    });
    expect(props.count).toMatchObject({ type: "integer" });
    expect(props.tags).toMatchObject({ type: "array", items: { type: "string" } });
    expect(props.nested?.additionalProperties).toBe(false);
  });

  it("leaves out the constraints a provider may refuse; the engine enforces them", () => {
    // (An integer carries zod's safe-integer bounds, which OpenAI strict mode accepts: checked live.)
    const rest = Object.fromEntries(
      Object.entries(node.properties as Record<string, SchemaNode>).filter(([k]) => k !== "count"),
    );
    const schema = JSON.stringify(json({ ...node, properties: rest }));
    for (const keyword of ["minimum", "maximum", "maxLength", "minLength", "pattern"]) {
      expect(schema).not.toContain(keyword);
    }
  });

  it("parses a conforming value and rejects a wrong type or enum value", () => {
    const zodSchema = schemaNodeToZod(node);
    expect(zodSchema.safeParse({ severity: "low", confidence: 0.5 }).success).toBe(true);
    expect(zodSchema.safeParse({ severity: "mid", confidence: 0.5 }).success).toBe(false);
    expect(zodSchema.safeParse({ severity: "low" }).success).toBe(false);
  });
});
