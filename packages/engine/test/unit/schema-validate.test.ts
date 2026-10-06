import { describe, expect, it } from "vitest";
import type { SchemaNode } from "@kampong/spec";
import { applySchemaDefaults, validateAgainstSchema } from "../../src/schema-validate.js";

// KAN-1832 part A: the small JSON Schema subset used by connector op inputs and outputs.

const obj = (properties: Record<string, SchemaNode>, required?: string[]): SchemaNode => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
});

describe("validateAgainstSchema", () => {
  it("accepts a conforming value and ignores undeclared extra properties", () => {
    const schema = obj({ a: { type: "string" }, n: { type: "integer" } }, ["a"]);

    expect(validateAgainstSchema(schema, { a: "x", n: 3, extra: true })).toEqual([]);
  });

  it("reports a missing required property and a wrong type, each with its path", () => {
    const schema = obj({ a: { type: "string" }, n: { type: "integer" } }, ["a"]);

    expect(validateAgainstSchema(schema, { n: 1.5 }, "input")).toEqual([
      "input.a is required",
      "input.n must be an integer",
    ]);
  });

  it("checks enum, string length and pattern, and numeric bounds", () => {
    const schema = obj({
      mode: { type: "string", enum: ["a", "b"] },
      code: { type: "string", pattern: "^[A-Z]{3}$", minLength: 3, maxLength: 3 },
      n: { type: "number", minimum: 1, maximum: 5 },
    });

    expect(validateAgainstSchema(schema, { mode: "c", code: "ab", n: 9 })).toEqual([
      "input.mode must be one of a, b",
      "input.code must be at least 3 characters",
      "input.code must match ^[A-Z]{3}$",
      "input.n must be at most 5",
    ]);
    expect(validateAgainstSchema(schema, { n: 0 })).toEqual(["input.n must be at least 1"]);
  });

  it("checks array items and nested objects", () => {
    const schema = obj({
      tags: { type: "array", items: { type: "string" } },
      user: obj({ id: { type: "integer" } }, ["id"]),
    });

    expect(validateAgainstSchema(schema, { tags: ["a", 2], user: {} })).toEqual([
      "input.tags[1] must be a string",
      "input.user.id is required",
    ]);
  });

  it("rejects a non-object where an object is required, and null for a typed value", () => {
    expect(validateAgainstSchema(obj({}), "text")).toEqual(["input must be an object"]);
    expect(validateAgainstSchema(obj({ a: { type: "string" } }), { a: null })).toEqual([
      "input.a must be a string",
    ]);
  });
});

describe("applySchemaDefaults", () => {
  it("fills a missing property with its default and leaves a provided one alone", () => {
    const schema = obj({
      limit: { type: "integer", default: 20 },
      q: { type: "string", default: "x" },
    });

    expect(applySchemaDefaults(schema, { q: "mine" })).toEqual({ limit: 20, q: "mine" });
  });

  it("fills defaults inside nested objects without inventing absent objects", () => {
    const schema = obj({
      opts: obj({ deep: { type: "boolean", default: true } }),
      other: obj({ x: { type: "string", default: "y" } }),
    });

    expect(applySchemaDefaults(schema, { opts: {} })).toEqual({ opts: { deep: true } });
  });
});
