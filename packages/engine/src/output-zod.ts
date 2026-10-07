import { z } from "zod";
import type { SchemaNode } from "@kampong/spec";

// The provider-facing shape of a step's `output_schema` (ADR-0038). Providers that enforce structured
// output (OpenAI's strict mode, reached directly or through OpenRouter) reject an open object, so the
// provider is given the real structure: types, enums, descriptions, required and optional properties. The
// constraints a provider may refuse (minimum, maxLength, pattern, ...) are left out here on purpose;
// `validateAgainstSchema` enforces them on the answer, with a retry.

export function schemaNodeToZod(node: SchemaNode): z.ZodType {
  let schema: z.ZodType;
  switch (node.type) {
    case "string":
      schema =
        node.enum && node.enum.every((v) => typeof v === "string")
          ? z.enum(node.enum as [string, ...string[]])
          : z.string();
      break;
    case "number":
      schema = z.number();
      break;
    case "integer":
      schema = z.number().int();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "array":
      schema = z.array(node.items ? schemaNodeToZod(node.items) : z.unknown());
      break;
    case "object": {
      const required = new Set(node.required ?? []);
      const shape: Record<string, z.ZodType> = {};
      for (const [name, child] of Object.entries(node.properties ?? {})) {
        const converted = schemaNodeToZod(child);
        shape[name] = required.has(name) ? converted : converted.optional();
      }
      schema = z.object(shape);
      break;
    }
  }
  return node.description ? schema.describe(node.description) : schema;
}
