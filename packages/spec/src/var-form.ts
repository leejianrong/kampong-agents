import type { PatchOp } from "./mutate.js";
import { secretEnvName } from "./webhook-auth.js";
import { varSchema, type AgentSpec, type SpecVar } from "./schema.js";

// The vars panel's write side (KAN-1850, ADR-0039): build one var from form text, and the patch ops that add,
// rename or remove it. A var named like a credential never holds a literal: it is read from the environment
// as `${NAME}`, the same rule the rest of the spec follows (AGENTS.md, secrets).

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|PRIVATE/i;

export interface VarFormInput {
  name: string;
  type: "number" | "string" | "list";
  items?: "string" | "number";
  description?: string;
  /** The literal default as typed; a list is comma-separated. Blank means no default. */
  default?: string;
  /** The environment variable to read the default from (`NAME` or `${NAME}`). Wins over `default`. */
  fromEnv?: string;
}

export interface VarFormResult {
  success: boolean;
  name?: string;
  var?: SpecVar;
  errors?: string[];
}

export function buildVarFromForm(input: VarFormInput): VarFormResult {
  const errors: string[] = [];
  const name = input.name.trim();
  if (!VAR_NAME.test(name) || name === "__proto__") {
    errors.push(
      `"${name}" is not a valid var name: use letters, digits and underscores, not starting with a digit`,
    );
  }
  let value: SpecVar["default"];
  const env = input.fromEnv?.trim() ?? "";
  const literal = input.default?.trim() ?? "";
  if (env !== "") {
    const envName = secretEnvName(env);
    if (envName === undefined) {
      errors.push("the environment variable must be a name like API_LIMIT, not a value");
    } else {
      value = `\${${envName}}`;
    }
  } else if (literal !== "") {
    if (SECRET_NAME.test(name) && input.type !== "number") {
      // The literal is not repeated in the message.
      errors.push(
        `"${name}" looks like a secret: read it from the environment instead of writing the value in the spec`,
      );
    } else if (input.type === "number") {
      const n = Number(literal);
      if (Number.isNaN(n)) errors.push("the default must be a number");
      else value = n;
    } else if (input.type === "list") {
      const parts = literal
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "");
      if (input.items === "number") {
        const numbers = parts.map(Number);
        if (numbers.some(Number.isNaN)) errors.push("every item of the default must be a number");
        else value = numbers;
      } else {
        value = parts;
      }
    } else {
      value = literal;
    }
  }
  if (errors.length > 0) return { success: false, errors };
  const candidate = {
    type: input.type,
    ...(input.type === "list" && input.items !== undefined && { items: input.items }),
    ...(input.description?.trim() && { description: input.description.trim() }),
    ...(value !== undefined && { default: value }),
  };
  const parsed = varSchema.safeParse(candidate);
  if (!parsed.success) return { success: false, errors: parsed.error.issues.map((i) => i.message) };
  return { success: true, name, var: parsed.data };
}

/** `vars` and the other new fields need version "1.1"; this raises a "1.0" spec to it. */
export function ensureVersion11Ops(spec: Pick<AgentSpec, "version">): PatchOp[] {
  return spec.version === "1.1" ? [] : [{ op: "set", path: ["version"], value: "1.1" }];
}

/** Adds a var, or replaces one of the same name. */
export function setVarOps(
  spec: Pick<AgentSpec, "version" | "vars">,
  name: string,
  value: SpecVar,
): PatchOp[] {
  return [
    ...ensureVersion11Ops(spec),
    spec.vars === undefined
      ? { op: "set", path: ["vars"], value: { [name]: value } }
      : { op: "set", path: ["vars", name], value },
  ];
}

const refPattern = (name: string) =>
  new RegExp(`(?<![A-Za-z0-9_.$\`])vars\\.${name}(?![A-Za-z0-9_])`, "g");

/** Where in the agent a string reads `vars.<name>`. */
export function varReferences(spec: AgentSpec, name: string): (string | number)[][] {
  const found: (string | number)[][] = [];
  const pattern = refPattern(name);
  const walk = (value: unknown, path: (string | number)[]) => {
    if (typeof value === "string") {
      pattern.lastIndex = 0;
      if (pattern.test(value)) found.push(path);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...path, i]));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
    }
  };
  walk(spec.agent, ["agent"]);
  return found;
}

export interface VarEditResult {
  ok: boolean;
  ops: PatchOp[];
  error?: string;
}

/** Removes a var, refusing while an expression still reads it (the validator would refuse the spec). */
export function removeVarOps(spec: AgentSpec, name: string): VarEditResult {
  const refs = varReferences(spec, name);
  if (refs.length > 0) {
    return {
      ok: false,
      ops: [],
      error: `vars.${name} is read in ${refs.length} place${refs.length === 1 ? "" : "s"} (${refs
        .slice(0, 3)
        .map((p) => p.join("."))
        .join(", ")}${refs.length > 3 ? ", ..." : ""}): change those first`,
    };
  }
  const names = Object.keys(spec.vars ?? {});
  // Removing the last var removes the block too, so the spec does not keep an empty `vars: {}`.
  return {
    ok: true,
    ops: [
      { op: "remove", path: names.length === 1 && names[0] === name ? ["vars"] : ["vars", name] },
    ],
  };
}

/** Renames a var and rewrites each `vars.<old>` that reads it, so the spec stays valid. */
export function renameVarOps(spec: AgentSpec, from: string, to: string): VarEditResult {
  const target = to.trim();
  if (!VAR_NAME.test(target) || target === "__proto__") {
    return { ok: false, ops: [], error: `"${target}" is not a valid var name` };
  }
  if (target === from) return { ok: true, ops: [] };
  const vars = spec.vars ?? {};
  if (!(from in vars)) return { ok: false, ops: [], error: `there is no var "${from}"` };
  if (target in vars) return { ok: false, ops: [], error: `there is already a var "${target}"` };
  const rewrite: PatchOp[] = varReferences(spec, from).map((path) => {
    let value: unknown = spec;
    for (const segment of path) value = (value as Record<string | number, unknown>)[segment];
    return {
      op: "set",
      path,
      value: (value as string).replace(refPattern(from), `vars.${target}`),
    };
  });
  return {
    ok: true,
    ops: [
      { op: "set", path: ["vars", target], value: vars[from] },
      { op: "remove", path: ["vars", from] },
      ...rewrite,
    ],
  };
}
