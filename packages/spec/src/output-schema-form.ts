import { schemaNodeSchema, type SchemaNode } from "./schema-node.js";
import type { PatchOp } from "./mutate.js";

// The output_schema editor's model (KAN-1850, ADR-0038): an action step's output is an object, shown as a
// list of fields (name, type, required, description). A field may be a string, number, integer, boolean, or a
// list of strings or numbers. Anything deeper (a nested object, an enum, bounds) is written in the YAML; a
// schema that has such parts is reported as `unsupported` so the form leaves it alone instead of dropping it.

export type OutputFieldType =
  "string" | "number" | "integer" | "boolean" | "string[]" | "number[]" | "integer[]" | "boolean[]";

export interface OutputField {
  name: string;
  type: OutputFieldType;
  required: boolean;
  description?: string;
}

const SCALARS = new Set(["string", "number", "integer", "boolean"]);

const PLAIN_KEYS = new Set(["type", "description", "items", "title"]);

/** The form's view of a schema, or why it cannot be shown as fields. */
export function outputFieldsFromSchema(schema: SchemaNode | undefined): {
  fields: OutputField[];
  unsupported: string[];
} {
  if (schema === undefined) return { fields: [], unsupported: [] };
  const unsupported: string[] = [];
  const fields: OutputField[] = [];
  for (const key of Object.keys(schema)) {
    if (!["type", "properties", "required", "description", "title"].includes(key)) {
      unsupported.push(`the schema's ${key}`);
    }
  }
  for (const [name, node] of Object.entries(schema.properties ?? {})) {
    let type: OutputFieldType | undefined;
    const extra = Object.keys(node).filter(
      (k) => !PLAIN_KEYS.has(k) || (k === "items" && node.type !== "array") || k === "title",
    );
    if (SCALARS.has(node.type) && extra.length === 0) {
      type = node.type as OutputFieldType;
    } else if (
      node.type === "array" &&
      node.items &&
      SCALARS.has(node.items.type) &&
      extra.length === 0 &&
      Object.keys(node.items).length === 1
    ) {
      type = `${node.items.type}[]` as OutputFieldType;
    }
    if (type === undefined) {
      unsupported.push(`${name}`);
      continue;
    }
    fields.push({
      name,
      type,
      required: (schema.required ?? []).includes(name),
      ...(node.description !== undefined && { description: node.description }),
    });
  }
  return { fields, unsupported };
}

export interface OutputSchemaResult {
  success: boolean;
  /** Undefined when there are no fields: the step then has no output_schema. */
  schema?: SchemaNode;
  errors?: string[];
}

export function buildOutputSchemaFromFields(
  fields: readonly OutputField[],
  options: { confidenceGate?: boolean } = {},
): OutputSchemaResult {
  const rows = fields.filter((f) => f.name.trim() !== "" || f.description?.trim());
  if (rows.length === 0) return { success: true };
  const errors: string[] = [];
  const seen = new Set<string>();
  const properties: Record<string, SchemaNode> = {};
  for (const field of rows) {
    const name = field.name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      errors.push(`"${name}" is not a valid field name: use letters, digits and underscores`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`field "${name}" appears twice`);
      continue;
    }
    seen.add(name);
    const description = field.description?.trim();
    properties[name] = field.type.endsWith("[]")
      ? {
          type: "array",
          items: { type: field.type.slice(0, -2) as SchemaNode["type"] },
          ...(description && { description }),
        }
      : { type: field.type as SchemaNode["type"], ...(description && { description }) };
  }
  if (errors.length > 0) return { success: false, errors };
  const required = rows.filter((f) => f.required).map((f) => f.name.trim());
  const candidate: SchemaNode = {
    type: "object",
    properties,
    ...(required.length > 0 && { required }),
  };
  if (options.confidenceGate) {
    const confidence = properties["confidence"];
    if (confidence?.type !== "number" || !required.includes("confidence")) {
      return {
        success: false,
        errors: [
          'a step with a confidence gate needs a required number field named "confidence" (0 to 1)',
        ],
      };
    }
  }
  const parsed = schemaNodeSchema.safeParse(candidate);
  if (!parsed.success) {
    return { success: false, errors: parsed.error.issues.map((i) => i.message) };
  }
  return { success: true, schema: parsed.data };
}

/**
 * Patch ops that make `after` the content of the mapping at `base`, touching only the keys that differ, so
 * comments and formatting on the keys that did not change survive (ADR-0002/ADR-0007). A key whose value is
 * missing from `after` is removed.
 */
export function diffFieldOps(
  base: (string | number)[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) {
      ops.push({ op: "set", path: [...base, key], value });
    }
  }
  for (const key of Object.keys(before)) {
    if (after[key] === undefined) ops.push({ op: "remove", path: [...base, key] });
  }
  return ops;
}
