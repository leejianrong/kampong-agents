import type { AgentSpec, WorkflowStep } from "./schema.js";
import { schemaNodeSchema, type SchemaNode } from "./schema-node.js";
import type { PatchOp } from "./mutate.js";
import { diagnoseExpression, type ExpressionScope } from "./expression-assist.js";
import { parseExpression, templateExpressions } from "./expression.js";
import { parseEvery } from "./schedule.js";

// Editing a step that is already in the workflow, from the canvas (KAM-162, a slice of KAM-110): which steps
// there are and where each sits in the file, and the form logic for an action step's per-step model settings and
// its `output_schema`. Same shape as the other form helpers: text in, a validated value or messages out, then a
// patch, so the rest of the file is left as it was. The checks are the loader's own rules for these fields.

export interface StepRef {
  name: string;
  /** Where the step sits in the YAML, for a patch. */
  path: (string | number)[];
  /** `action`, a `type:` value, `foreach` or `branch`. */
  kind: string;
  /** Names of the foreach or branch steps it sits inside, outermost first. */
  within: string[];
  step: WorkflowStep;
}

function kindOf(step: WorkflowStep): string {
  if ("foreach" in step) return "foreach";
  if ("branch" in step) return "branch";
  if ("stop" in step) return "stop";
  if ("type" in step) return step.type;
  return "action";
}

/** Every step in the workflow, in order, with a branch's arms and a foreach's body after their parent. */
export function listSteps(spec: AgentSpec): StepRef[] {
  const out: StepRef[] = [];
  const walk = (list: readonly WorkflowStep[], path: (string | number)[], within: string[]) => {
    list.forEach((step, i) => {
      const here = [...path, i];
      out.push({ name: step.step, path: here, kind: kindOf(step), within, step });
      const inside = [...within, step.step];
      if ("foreach" in step) {
        walk(step.foreach.steps as WorkflowStep[], [...here, "foreach", "steps"], inside);
      } else if ("branch" in step) {
        const b = step.branch;
        if ("if" in b) {
          walk(b.then, [...here, "branch", "then"], inside);
          if (b.else) walk(b.else, [...here, "branch", "else"], inside);
        } else {
          for (const [name, arm] of Object.entries(b.cases)) {
            walk(arm, [...here, "branch", "cases", name], inside);
          }
          if (b.default) walk(b.default, [...here, "branch", "default"], inside);
        }
      }
    });
  };
  walk(spec.agent.workflow, ["agent", "workflow"], []);
  return out;
}

// ---- output_schema as a form ---------------------------------------------------------------------

export type SchemaType = SchemaNode["type"];

export interface SchemaDraft {
  type: SchemaType;
  description: string;
  /** Allowed values, comma-separated (scalar types only). */
  enum: string;
  /** As text, blank for none. `minLength` and `maxLength` are for a string, `minimum` and `maximum` for a number. */
  minLength: string;
  maxLength: string;
  minimum: string;
  maximum: string;
  /** Object only. */
  properties: { name: string; required: boolean; draft: SchemaDraft }[];
  /** Array only. */
  items?: SchemaDraft;
  /** Keywords the form has no field for (minimum, pattern, ...): kept as they were. */
  extra: Record<string, unknown>;
}

const HANDLED = new Set([
  "type",
  "description",
  "enum",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "properties",
  "required",
  "items",
]);

export const emptySchemaDraft = (type: SchemaType = "string"): SchemaDraft => ({
  type,
  description: "",
  enum: "",
  minLength: "",
  maxLength: "",
  minimum: "",
  maximum: "",
  properties: [],
  extra: {},
});

export function schemaToDraft(node: SchemaNode): SchemaDraft {
  const required = new Set(node.required ?? []);
  return {
    type: node.type,
    description: node.description ?? "",
    enum: (node.enum ?? []).join(", "),
    minLength: node.minLength === undefined ? "" : String(node.minLength),
    maxLength: node.maxLength === undefined ? "" : String(node.maxLength),
    minimum: node.minimum === undefined ? "" : String(node.minimum),
    maximum: node.maximum === undefined ? "" : String(node.maximum),
    properties: Object.entries(node.properties ?? {}).map(([name, child]) => ({
      name,
      required: required.has(name),
      draft: schemaToDraft(child),
    })),
    ...(node.items && { items: schemaToDraft(node.items) }),
    extra: Object.fromEntries(Object.entries(node).filter(([k]) => !HANDLED.has(k))),
  };
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function enumValues(
  draft: SchemaDraft,
  where: string,
  errors: string[],
): (string | number | boolean)[] | undefined {
  const parts = draft.enum
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) return undefined;
  const out: (string | number | boolean)[] = [];
  for (const part of parts) {
    if (draft.type === "string") out.push(part);
    else if (draft.type === "boolean" && (part === "true" || part === "false")) {
      out.push(part === "true");
    } else if (
      (draft.type === "number" || draft.type === "integer") &&
      part !== "" &&
      Number.isFinite(Number(part))
    ) {
      out.push(Number(part));
    } else errors.push(`${where}: enum value "${part}" is not a valid ${draft.type}`);
  }
  return out;
}

/** A limit field: blank is none, otherwise a number (a whole number of 0 or more when `whole`). */
function limit(text: string, name: string, whole: boolean, where: string, errors: string[]) {
  const t = text.trim();
  if (t === "") return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || (whole && (!Number.isInteger(n) || n < 0))) {
    errors.push(
      `${where}: ${name} "${t}" must be ${whole ? "a whole number, 0 or more" : "a number"}`,
    );
    return undefined;
  }
  return n;
}

function nodeFromDraft(draft: SchemaDraft, where: string, errors: string[]): SchemaNode {
  const node: Record<string, unknown> = { type: draft.type };
  const description = draft.description.trim();
  if (description) node.description = description;
  if (draft.type === "object" || draft.type === "array") {
    // enum on a container is meaningless, so it is not offered; a stale one is dropped.
  } else {
    const values = enumValues(draft, where, errors);
    if (values) node.enum = values;
  }
  if (draft.type === "string") {
    const min = limit(draft.minLength, "minLength", true, where, errors);
    const max = limit(draft.maxLength, "maxLength", true, where, errors);
    if (min !== undefined && max !== undefined && min > max) {
      errors.push(`${where}: minLength ${min} is more than maxLength ${max}`);
    }
    if (min !== undefined) node.minLength = min;
    if (max !== undefined) node.maxLength = max;
  }
  if (draft.type === "number" || draft.type === "integer") {
    const min = limit(draft.minimum, "minimum", false, where, errors);
    const max = limit(draft.maximum, "maximum", false, where, errors);
    if (min !== undefined && max !== undefined && min > max) {
      errors.push(`${where}: minimum ${min} is more than maximum ${max}`);
    }
    if (min !== undefined) node.minimum = min;
    if (max !== undefined) node.maximum = max;
  }
  if (draft.type === "object") {
    if (draft.properties.length === 0) {
      errors.push(`${where}: an object must list its properties (open objects are not supported)`);
    }
    const names = new Set<string>();
    const properties: Record<string, SchemaNode> = {};
    const required: string[] = [];
    for (const prop of draft.properties) {
      const name = prop.name.trim();
      const at = `${where}.${name || "(unnamed)"}`;
      if (!NAME.test(name) || name === "__proto__") {
        errors.push(
          `${where}: "${name}" is not a valid property name: use letters, digits and underscores, not starting with a digit`,
        );
        continue;
      }
      if (names.has(name)) {
        errors.push(`${where}: property "${name}" is listed more than once`);
        continue;
      }
      names.add(name);
      properties[name] = nodeFromDraft(prop.draft, at, errors);
      if (prop.required) required.push(name);
    }
    node.properties = properties;
    if (required.length > 0) node.required = required;
  }
  if (draft.type === "array") {
    if (!draft.items) errors.push(`${where}: an array must declare its items`);
    else node.items = nodeFromDraft(draft.items, `${where}[]`, errors);
  }
  // Keywords of another type (a stale minimum on a string, say) are left to the schema's own checks.
  return { ...draft.extra, ...node } as unknown as SchemaNode;
}

export type SchemaResult =
  { success: true; value: SchemaNode } | { success: false; errors: string[] };

/**
 * Builds the `output_schema` the form describes. `confidenceGate` is the step's own flag: the loader then
 * requires a numeric, required `confidence` with no default.
 */
export function buildOutputSchema(draft: SchemaDraft, confidenceGate = false): SchemaResult {
  const errors: string[] = [];
  if (draft.type !== "object") {
    return { success: false, errors: ['output_schema must describe an object (type: "object")'] };
  }
  const node = nodeFromDraft(draft, "output_schema", errors);
  if (errors.length === 0) {
    const parsed = schemaNodeSchema.safeParse(node);
    if (!parsed.success) errors.push(...parsed.error.issues.map((i) => i.message));
  }
  if (confidenceGate && errors.length === 0) {
    const confidence = node.properties?.confidence;
    if (
      (confidence?.type !== "number" && confidence?.type !== "integer") ||
      !node.required?.includes("confidence") ||
      confidence.default !== undefined
    ) {
      errors.push(
        'a confidence_gate step with an output_schema must declare a numeric "confidence" property (0 to 1) that is required and has no default',
      );
    }
  }
  return errors.length > 0 ? { success: false, errors } : { success: true, value: node };
}

// ---- per-step model settings ---------------------------------------------------------------------

export interface ActionStepEditInput {
  /** The prompt template for the step, `{{ }}` references included. Blank means the step has none. */
  query: string;
  /** Blank means the agent's own. */
  instructions: string;
  model: string;
  /** As text; blank means the agent's own. */
  temperature: string;
  /** Undefined removes the step's output_schema. */
  schema?: SchemaDraft;
}

export type ActionStepEditResult =
  { success: true; patch: PatchOp[] } | { success: false; errors: string[] };

type ActionStep = Extract<WorkflowStep, { action: string }>;

export function actionStepToEditInput(step: ActionStep): ActionStepEditInput {
  return {
    query: step.query ?? "",
    instructions: step.instructions ?? "",
    model: step.model ?? "",
    temperature: step.temperature === undefined ? "" : String(step.temperature),
    ...(step.output_schema && { schema: schemaToDraft(step.output_schema) }),
  };
}

/** JSON with sorted keys, so two schemas that differ only in key order compare equal and an untouched one is not rewritten. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

/** Validates the form for a spec of `version` and returns the patch that sets (or clears) each field. */
export function buildActionStepEdit(
  input: ActionStepEditInput,
  step: { path: (string | number)[]; step: ActionStep },
  version: string,
  scope?: ExpressionScope,
): ActionStepEditResult {
  const errors: string[] = [];
  const query = input.query.trim();
  // Each `{{ }}` in the prompt is an expression, checked as the loader checks it (when the form has a scope).
  for (const { expression } of templateExpressions(query)) {
    const parsed = parseExpression(expression);
    if (!parsed.ok) for (const e of parsed.errors) errors.push(`query: ${e.message}`);
    else if (scope) {
      for (const d of diagnoseExpression(expression, scope)) errors.push(`query: ${d.message}`);
    }
  }
  const instructions = input.instructions.trim();
  const model = input.model.trim();
  const temperatureText = input.temperature.trim();
  let temperature: number | undefined;
  if (temperatureText !== "") {
    const n = Number(temperatureText);
    if (!Number.isFinite(n) || n < 0 || n > 2) {
      errors.push(`temperature "${temperatureText}" must be a number from 0 to 2`);
    } else temperature = n;
  }
  let schema: SchemaNode | undefined;
  if (input.schema) {
    const built = buildOutputSchema(input.schema, step.step.confidence_gate === true);
    if (built.success) schema = built.value;
    else errors.push(...built.errors);
  }
  if (version !== "1.1") {
    const used: [string, boolean][] = [
      ["instructions", instructions !== ""],
      ["model", model !== ""],
      ["temperature", temperature !== undefined],
      ["output_schema", schema !== undefined || input.schema !== undefined],
    ];
    for (const [field, on] of used) if (on) errors.push(`${field} needs version "1.1"`);
  }
  if (errors.length > 0) return { success: false, errors };

  const patch: PatchOp[] = [];
  const field = (name: string, value: unknown, before: unknown) => {
    const at = [...step.path, name];
    if (value === undefined) {
      if (before !== undefined) patch.push({ op: "remove", path: at });
    } else if (canonical(value) !== canonical(before)) {
      patch.push({ op: "set", path: at, value });
    }
  };
  // Compared trimmed, so a block scalar that ends in a newline is not rewritten when the text is untouched.
  const text = (name: string, value: string, before: string | undefined) => {
    if (value === (before ?? "").trim()) return;
    field(name, value || undefined, before);
  };
  text("query", query, step.step.query);
  text("instructions", instructions, step.step.instructions);
  field("model", model || undefined, step.step.model);
  field("temperature", temperature, step.step.temperature);
  field("output_schema", schema, step.step.output_schema);
  return { success: true, patch };
}

// ---- transform, validate and dedupe steps (KAM-152) ----------------------------------------------

/** One value a transform sets. The expression may span lines (a `|-` block in the file). */
export interface SetRow {
  name: string;
  expression: string;
}

export type DataStepEditInput =
  | { kind: "transform"; set: SetRow[] }
  | { kind: "validate"; assert: string; onFail: "fail" | "skip"; message: string }
  | { kind: "dedupe"; key: string; ttl: string };

type DataStep = Extract<WorkflowStep, { type: "transform" | "validate" | "dedupe" }>;

/** The form's values for an existing data step. A transform's `set` is one row per value, in file order. */
export function dataStepToEditInput(step: DataStep): DataStepEditInput {
  if (step.type === "transform") {
    return {
      kind: "transform",
      set: Object.entries(step.set).map(([name, expression]) => ({ name, expression })),
    };
  }
  if (step.type === "validate") {
    return {
      kind: "validate",
      assert: step.assert,
      onFail: step.on_fail === "skip" ? "skip" : "fail",
      message: step.message ?? "",
    };
  }
  return { kind: "dedupe", key: step.once.key, ttl: step.once.ttl };
}

/**
 * Validates the form and returns the patch for the fields that changed. Expressions get the loader's syntax check
 * and, when `scope` is given, its name check, so a step that would not load is not saved. A transform's `set` is
 * patched one name at a time, so the values left alone keep the style they were written in (a `|-` block stays one)
 * and a removed row removes its name.
 */
export function buildDataStepEdit(
  input: DataStepEditInput,
  step: { path: (string | number)[]; step: DataStep },
  version: string,
  scope?: ExpressionScope,
): ActionStepEditResult {
  const errors: string[] = [];
  if (version !== "1.1") errors.push(`a ${input.kind} step needs version "1.1"`);
  const check = (source: string, where: string) => {
    if (source.trim() === "") return;
    const parsed = parseExpression(source);
    if (!parsed.ok) {
      for (const e of parsed.errors) errors.push(`${where}: ${e.message}`);
    } else if (scope) {
      for (const d of diagnoseExpression(source, scope)) errors.push(`${where}: ${d.message}`);
    }
  };
  const patch: PatchOp[] = [];
  const put = (path: (string | number)[], value: unknown, before: unknown) => {
    if (JSON.stringify(value) !== JSON.stringify(before)) patch.push({ op: "set", path, value });
  };
  const at = step.path;
  const existing = step.step;

  if (input.kind === "transform" && existing.type === "transform") {
    const rows = input.set.map((row) => ({
      name: row.name.trim(),
      expression: row.expression.trim(),
    }));
    if (rows.length === 0) errors.push("Add at least one value as name: expression");
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.name === "") errors.push("A value needs a name");
      else if (seen.has(row.name)) errors.push(`"${row.name}" is set twice`);
      else seen.add(row.name);
      if (row.expression === "") errors.push(`${row.name || "A value"} needs an expression`);
      else check(row.expression, row.name);
    }
    if (errors.length === 0) {
      const before = existing.set;
      for (const name of Object.keys(before)) {
        if (!seen.has(name)) patch.push({ op: "remove", path: [...at, "set", name] });
      }
      for (const row of rows) put([...at, "set", row.name], row.expression, before[row.name]);
    }
  } else if (input.kind === "validate" && existing.type === "validate") {
    if (input.assert.trim() === "") errors.push("A validate step needs an assertion");
    check(input.assert, "assert");
    const message = input.message.trim();
    put([...at, "assert"], input.assert.trim(), existing.assert);
    put([...at, "on_fail"], input.onFail, existing.on_fail ?? "fail");
    if (message === "") {
      if (existing.message !== undefined) patch.push({ op: "remove", path: [...at, "message"] });
    } else put([...at, "message"], message, existing.message);
  } else if (input.kind === "dedupe" && existing.type === "dedupe") {
    const key = input.key.trim();
    const ttl = input.ttl.trim();
    if (key === "") errors.push("A dedupe step needs a key expression");
    check(key, "key");
    if (ttl === "") errors.push("A dedupe step needs a ttl (e.g. 24h)");
    else {
      const parsed = parseEvery(ttl);
      if (!parsed.ok) errors.push(`ttl: ${parsed.error}`);
    }
    put([...at, "once", "key"], key, existing.once.key);
    put([...at, "once", "ttl"], ttl, existing.once.ttl);
  } else {
    errors.push("The form does not match the step");
  }
  return errors.length > 0 ? { success: false, errors } : { success: true, patch };
}
