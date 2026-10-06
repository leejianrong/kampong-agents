// Vendored from packages/engine/src/schema-validate.ts as part of a `kampong export`
// -- see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. The
// only change from the source file is the type import, which now comes from
// the local ./spec-types.js rather than "@kampong/spec" (this project has no
// dependency on that package -- ADR-0002). From here on this file is yours: it
// will not be touched again by a future export.
//
import type { SchemaNode } from "./spec-types.js";

// Validation for the JSON Schema subset a connector op declares for its input and output (KAN-1832,
// ADR-0029). The subset itself is enforced when a manifest is linted; this checks a runtime value
// against it. Every problem is reported, with a path, so a bad call names everything wrong at once.

function describeType(node: SchemaNode): string {
  return node.type === "integer"
    ? "an integer"
    : `a${node.type === "object" || node.type === "array" ? "n" : ""} ${node.type}`;
}

export function validateAgainstSchema(node: SchemaNode, value: unknown, path = "input"): string[] {
  const errors: string[] = [];

  switch (node.type) {
    case "string":
      if (typeof value !== "string") return [`${path} must be a string`];
      if (node.minLength !== undefined && value.length < node.minLength) {
        errors.push(`${path} must be at least ${node.minLength} characters`);
      }
      if (node.maxLength !== undefined && value.length > node.maxLength) {
        errors.push(`${path} must be at most ${node.maxLength} characters`);
      }
      if (node.pattern !== undefined && !new RegExp(node.pattern).test(value)) {
        errors.push(`${path} must match ${node.pattern}`);
      }
      break;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value))
        return [`${path} must be ${describeType(node)}`];
      if (node.type === "integer" && !Number.isInteger(value))
        return [`${path} must be an integer`];
      if (node.minimum !== undefined && value < node.minimum)
        errors.push(`${path} must be at least ${node.minimum}`);
      if (node.maximum !== undefined && value > node.maximum)
        errors.push(`${path} must be at most ${node.maximum}`);
      break;
    case "boolean":
      if (typeof value !== "boolean") return [`${path} must be a boolean`];
      break;
    case "array":
      if (!Array.isArray(value)) return [`${path} must be an array`];
      if (node.items) {
        value.forEach((entry, i) =>
          errors.push(...validateAgainstSchema(node.items!, entry, `${path}[${i}]`)),
        );
      }
      break;
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return [`${path} must be an object`];
      }
      const record = value as Record<string, unknown>;
      for (const name of node.required ?? []) {
        if (record[name] === undefined) errors.push(`${path}.${name} is required`);
      }
      for (const [name, child] of Object.entries(node.properties ?? {})) {
        if (record[name] !== undefined)
          errors.push(...validateAgainstSchema(child, record[name], `${path}.${name}`));
      }
      return errors;
    }
  }

  if (node.enum !== undefined && !node.enum.includes(value as string | number | boolean)) {
    errors.push(`${path} must be one of ${node.enum.join(", ")}`);
  }
  return errors;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Returns a copy of `value` with declared defaults filled in, recursing into nested objects (also
 * absent ones, so a default inside `options` applies whether or not the caller passed `options`) and
 * into arrays of objects.
 */
export function applySchemaDefaults(
  node: SchemaNode,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...value };
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    const current = result[name];
    if (current === undefined) {
      if (child.default !== undefined) {
        result[name] = child.default;
      } else if (child.type === "object") {
        const nested = applySchemaDefaults(child, {});
        if (Object.keys(nested).length > 0) result[name] = nested;
      }
    } else if (child.type === "object" && isRecord(current)) {
      result[name] = applySchemaDefaults(child, current);
    } else if (child.type === "array" && Array.isArray(current) && child.items?.type === "object") {
      result[name] = current.map((item) =>
        isRecord(item) ? applySchemaDefaults(child.items!, item) : item,
      );
    }
  }
  return result;
}
