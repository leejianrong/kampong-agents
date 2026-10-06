import type { SchemaNode } from "@kampong/spec";

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

/** Returns a copy of `value` with declared defaults filled in for missing properties. */
export function applySchemaDefaults(
  node: SchemaNode,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...value };
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    if (result[name] === undefined) {
      if (child.default !== undefined) result[name] = child.default;
    } else if (
      child.type === "object" &&
      result[name] !== null &&
      typeof result[name] === "object"
    ) {
      result[name] = applySchemaDefaults(child, result[name] as Record<string, unknown>);
    }
  }
  return result;
}
