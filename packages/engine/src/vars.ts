import type { SpecVar, SpecVars } from "@kampong/spec";

// Resolving a spec's `vars` block into values (KAN-1840, ADR-0027): a pure function of the declaration, the
// environment and any overrides, so a run and an export agree on what `vars.x` holds. It lives in the engine,
// not the spec package, because a run needs it and the exported runtime vendors engine files only.

export type VarValue = number | string | (number | string)[];

export interface ResolvedVars {
  values: Record<string, VarValue>;
  /** One per var that has no usable value; the engine fails the run with these, never with a guess. */
  errors: { name: string; message: string }[];
}

const DECIMAL = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const ENV_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Text from the environment (or a `--var` flag) as the declared type. A number must be finite. A list is a
 * JSON array if it starts with `[`, otherwise comma-separated with blanks dropped.
 */
export function parseVarText(def: SpecVar, text: string): VarValue | { error: string } {
  if (def.type === "string") return text;
  if (def.type === "number") {
    // Decimal only: Number() would also accept "0x10" and "Infinity".
    const n = Number(text.trim());
    return DECIMAL.test(text.trim()) && Number.isFinite(n)
      ? n
      : { error: `"${text}" is not a number` };
  }
  const item = def.items ?? "string";
  let raw: unknown[];
  if (text.trim().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return { error: `"${text}" is not a list` };
      raw = parsed;
    } catch {
      return { error: `"${text}" is not a valid JSON list` };
    }
  } else {
    raw = text
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
  }
  const out: (number | string)[] = [];
  for (const entry of raw) {
    if (item === "number") {
      const n = typeof entry === "number" ? entry : Number(String(entry).trim());
      const decimal = typeof entry === "number" || DECIMAL.test(String(entry).trim());
      if (!Number.isFinite(n) || !decimal) {
        return { error: `"${String(entry)}" in the list is not a number` };
      }
      out.push(n);
    } else if (typeof entry === "string" || typeof entry === "number") {
      out.push(String(entry));
    } else {
      return { error: "a list of strings can only hold strings" };
    }
  }
  return out;
}

function matches(def: SpecVar, value: unknown): value is VarValue {
  if (def.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (def.type === "string") return typeof value === "string";
  const item = def.items ?? "string";
  return Array.isArray(value) && value.every((x) => typeof x === item);
}

/**
 * Each var's value, taken from (in order) an override, then its default; a default of `${NAME}` reads the
 * environment variable NAME, and an unset or empty one is an error naming it. An override given as text is
 * parsed like an environment value; one given already typed must have the declared type.
 */
export function resolveVars(
  vars: SpecVars | undefined,
  env: NodeJS.ProcessEnv = {},
  overrides: Record<string, unknown> = {},
): ResolvedVars {
  // No prototype, so a var named like an Object property cannot be mistaken for one.
  const values = Object.create(null) as Record<string, VarValue>;
  const errors: ResolvedVars["errors"] = [];
  for (const [name, def] of Object.entries(vars ?? {})) {
    const fail = (message: string) => errors.push({ name, message: `vars.${name}: ${message}` });
    let source: unknown;
    let from = "its default";
    if (Object.hasOwn(overrides, name)) {
      source = overrides[name];
      from = "the value given for it";
    } else if (def.default !== undefined) {
      source = def.default;
    } else {
      fail("no value: it has no default and none was given");
      continue;
    }
    if (typeof source === "string") {
      const placeholder = ENV_PLACEHOLDER.exec(source);
      let text = source;
      if (placeholder && from === "its default") {
        const raw = env[placeholder[1]!];
        if (raw === undefined || raw === "") {
          fail(`environment variable ${placeholder[1]} is not set (it is this var's default)`);
          continue;
        }
        text = raw;
        from = `environment variable ${placeholder[1]}`;
      }
      const parsed = parseVarText(def, text);
      if (typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) {
        fail(`${from}: ${parsed.error} (expected a ${def.type})`);
      } else values[name] = parsed as VarValue;
      continue;
    }
    if (matches(def, source)) values[name] = source;
    else fail(`${from} is not a ${def.type}`);
  }
  return { values, errors };
}
