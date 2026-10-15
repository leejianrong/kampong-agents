import { varSchema, VAR_NAME, type SpecVar } from "./schema.js";
import type { PatchOp } from "./mutate.js";

// The canvas "Spec vars" panel's form logic (KAM-159, a slice of KAM-110), in the same shape as the tool and
// workflow forms: plain text in, a validated `vars` entry or a list of messages out, with no model call and no
// way to submit what the schema would refuse. The panel sends the result as a patch, so everything else in the
// file (comments, order, spacing) is left as it was.

export interface VarFormInput {
  name: string;
  type: "string" | "number" | "list";
  /** What a list holds. Ignored for the other types; defaults to strings. */
  items?: "string" | "number";
  description?: string;
  /**
   * The default as text. A number is parsed, a list is a JSON array or comma-separated, `${ENV_VAR}` reads
   * the environment, and blank means no default (the run must supply a value).
   */
  default?: string;
}

export type VarFormResult =
  { success: true; name: string; value: SpecVar } | { success: false; errors: string[] };

const ENV_DEFAULT = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

function parseDefault(input: VarFormInput): { value?: SpecVar["default"]; error?: string } {
  const text = (input.default ?? "").trim();
  if (text === "") return {};
  if (ENV_DEFAULT.test(text)) return { value: text };
  if (input.type === "string") return { value: input.default! };
  const number = (part: string): number | undefined => {
    const n = part.trim() === "" ? Number.NaN : Number(part);
    return Number.isFinite(n) ? n : undefined;
  };
  if (input.type === "number") {
    const n = number(text);
    return n === undefined
      ? {
          error: `default "${text}" is not a number (or write \${ENV_VAR} to read it from the environment)`,
        }
      : { value: n };
  }
  // list
  let parts: unknown[];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error("not a list");
      parts = parsed;
    } catch {
      return { error: `default ${text} is not a JSON list; write ["a", "b"] or a, b` };
    }
  } else {
    parts = text
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "");
  }
  if (input.items === "number") {
    const numbers = parts.map((p) => (typeof p === "number" ? p : number(String(p))));
    const bad = numbers.findIndex((n) => n === undefined);
    return bad >= 0
      ? { error: `default item ${bad + 1} ("${String(parts[bad])}") is not a number` }
      : { value: numbers as number[] };
  }
  return { value: parts.map(String) };
}

/** Validates the form and builds the `vars` entry. `existing` is the names already declared, for a new var. */
export function buildVarFromForm(
  input: VarFormInput,
  existing: readonly string[] = [],
): VarFormResult {
  const errors: string[] = [];
  const name = input.name.trim();
  if (name === "") errors.push("A var needs a name");
  else if (!VAR_NAME.test(name) || name === "__proto__") {
    errors.push(
      `"${name}" is not a valid var name: use letters, digits and underscores, not starting with a digit`,
    );
  } else if (existing.includes(name)) {
    errors.push(`a var named "${name}" already exists`);
  }

  const parsed = parseDefault(input);
  if (parsed.error) errors.push(parsed.error);

  const description = input.description?.trim();
  const candidate = {
    type: input.type,
    ...(input.type === "list" && input.items === "number" && { items: "number" as const }),
    ...(description && { description }),
    ...(parsed.value !== undefined && { default: parsed.value }),
  };
  const result = varSchema.safeParse(candidate);
  if (!result.success) errors.push(...result.error.issues.map((issue) => issue.message));
  if (errors.length > 0 || !result.success) return { success: false, errors };
  return { success: true, name, value: result.data };
}

/** The form's text for an existing var, to edit it in place. */
export function varToFormInput(name: string, value: SpecVar): VarFormInput {
  const def = value.default;
  return {
    name,
    type: value.type,
    ...(value.items && { items: value.items }),
    ...(value.description !== undefined && { description: value.description }),
    ...(def !== undefined && { default: Array.isArray(def) ? def.join(", ") : String(def) }),
  };
}

/** `declared` is how many vars the spec has now: the first one creates the `vars:` block (above `agent:`). */
export const setVarPatch = (name: string, value: SpecVar, declared = 1): PatchOp[] => [
  declared === 0
    ? { op: "set", path: ["vars"], value: { [name]: value } }
    : { op: "set", path: ["vars", name], value },
];
export const removeVarPatch = (name: string, remaining: number): PatchOp[] => [
  // The last var takes the empty `vars:` with it, so the file does not keep a key with nothing under it.
  { op: "remove", path: remaining <= 1 ? ["vars"] : ["vars", name] },
];
