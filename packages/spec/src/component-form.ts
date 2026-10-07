import { parseDocument } from "yaml";
import type { ComponentManifest, OpEffect, SchemaNode } from "./component.js";
import { describePermissions, permissionsOf } from "./permissions.js";
import type { Revocation } from "./registry-index.js";
import { toolSchema, type AgentSpec, type Tool } from "./schema.js";

// KAN-1885: what the canvas needs to build a form for a component op, as pure functions so the logic
// is tested without a DOM and shared with any headless tooling. A form covers the part of the op
// input schema that maps cleanly to fields; anything else falls back to editing `with` as YAML.

// ---- Catalog: what the server tells the canvas about an installed component ------------------------

export interface ComponentCatalogOp {
  title?: string;
  description?: string;
  effect: OpEffect;
  input?: SchemaNode;
  output?: SchemaNode;
}

/**
 * Whether a run will accept this component (KAN-1834): `first-party` ships with kampong and needs no pin;
 * `pinned` matches its pin in kampong.lock; `changed` is pinned but its files are different now (a run
 * refuses it until it is reviewed and re-pinned); `unpinned` has never been pinned.
 */
export interface ComponentPinStatus {
  state: "first-party" | "pinned" | "changed" | "unpinned";
  /** For `changed`: what the new version may do that the pinned one could not. */
  widened?: string[];
}

export interface ComponentCatalogEntry {
  id: string;
  version: string;
  digest: string;
  /** What the component may do, in words, for the author to read before pinning it. */
  permissionsSummary: string;
  /** Set by a server that knows the project's lockfile; absent where there is none to compare with. */
  pin?: ComponentPinStatus;
  /** Set when the registry index revokes exactly these files: a run, a pin and an export all refuse it. */
  revoked?: Revocation;
  title?: string;
  description?: string;
  /** Secret slots a spec may remap: the default environment variable each reads. */
  slots: { name: string; env: string }[];
  /** Non-secret per-use values. */
  config: {
    name: string;
    title?: string;
    description?: string;
    default?: string;
    pattern?: string;
    /** No default, so a value must be supplied. */
    required: boolean;
  }[];
  ops: Record<string, ComponentCatalogOp>;
}

export interface ComponentCatalog {
  components: ComponentCatalogEntry[];
  /** Manifests that exist but did not load, so the canvas can say why a component is missing. */
  problems: string[];
}

/** The form-relevant view of a manifest: no requests, hosts, auth injection or module code. */
export function catalogEntryFromManifest(
  manifest: ComponentManifest,
  digest: string,
): ComponentCatalogEntry {
  const ops: Record<string, ComponentCatalogOp> = Object.create(null) as Record<
    string,
    ComponentCatalogOp
  >;
  for (const [name, op] of Object.entries(manifest.ops)) {
    ops[name] = {
      ...(op.title !== undefined && { title: op.title }),
      ...(op.description !== undefined && { description: op.description }),
      effect: op.effect,
      ...(op.input !== undefined && { input: op.input }),
      ...(op.output !== undefined && { output: op.output }),
    };
  }
  return {
    id: manifest.id,
    version: manifest.version,
    digest,
    permissionsSummary: describePermissions(permissionsOf(manifest)),
    ...(manifest.title !== undefined && { title: manifest.title }),
    ...(manifest.description !== undefined && { description: manifest.description }),
    slots: Object.entries(manifest.auth?.slots ?? {}).map(([name, slot]) => ({
      name,
      env: slot.env,
    })),
    config: Object.entries(manifest.config ?? {}).map(([name, param]) => ({
      name,
      required: param.default === undefined,
      ...(param.title !== undefined && { title: param.title }),
      ...(param.description !== undefined && { description: param.description }),
      ...(param.default !== undefined && { default: param.default }),
      ...(param.pattern !== undefined && { pattern: param.pattern }),
    })),
    ops,
  };
}

// ---- Planning a form from an input schema ------------------------------------------------------------

export type FormFieldKind =
  "text" | "multiline" | "number" | "integer" | "boolean" | "enum" | "text_list" | "object";

export interface FormField {
  name: string;
  label: string;
  description?: string;
  kind: FormFieldKind;
  required: boolean;
  default?: string | number | boolean;
  options?: (string | number | boolean)[];
  /** One level only: the scalar fields of an object. */
  children?: FormField[];
}

export interface OpFormPlan {
  supported: boolean;
  fields: FormField[];
  /** Why the form cannot be generated, naming the property (shown above the YAML fallback). */
  reason?: string;
}

function scalarKind(node: SchemaNode): FormFieldKind | undefined {
  if (node.enum !== undefined && node.type !== "object" && node.type !== "array") return "enum";
  switch (node.type) {
    case "string":
      return node.format === "multiline" ? "multiline" : "text";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    default:
      return undefined;
  }
}

function fieldFor(
  name: string,
  node: SchemaNode,
  required: boolean,
  path: string,
  allowObject: boolean,
): FormField | string {
  const base = {
    name,
    label: node.title ?? name,
    ...(node.description !== undefined && { description: node.description }),
    required,
    ...(node.default !== undefined && { default: node.default }),
  };
  const scalar = scalarKind(node);
  if (scalar !== undefined) {
    return { ...base, kind: scalar, ...(node.enum !== undefined && { options: node.enum }) };
  }
  if (node.type === "array") {
    if (node.items?.type === "string" && node.items.enum === undefined) {
      return { ...base, kind: "text_list" };
    }
    return `${path}: only a list of strings is supported`;
  }
  if (node.type === "object") {
    // A map with no declared properties has nothing to build fields from.
    if (node.properties === undefined || Object.keys(node.properties).length === 0) {
      return `${path}: an object with no declared properties is not supported`;
    }
    if (!allowObject) return `${path}: an object nested more than one level deep is not supported`;
    const children: FormField[] = [];
    const need = new Set(node.required ?? []);
    for (const [childName, child] of Object.entries(node.properties ?? {})) {
      const field = fieldFor(childName, child, need.has(childName), `${path}.${childName}`, false);
      if (typeof field === "string") return field;
      children.push(field);
    }
    return { ...base, kind: "object", children };
  }
  return `${path}: unsupported type`;
}

/** Plans the fields for an op's input schema, or says why a form cannot be generated for it. */
export function planOpForm(input: SchemaNode | undefined): OpFormPlan {
  if (input === undefined) return { supported: true, fields: [] };
  if (input.type !== "object") {
    return { supported: false, fields: [], reason: "the input is not an object schema" };
  }
  const need = new Set(input.required ?? []);
  const fields: FormField[] = [];
  for (const [name, node] of Object.entries(input.properties ?? {})) {
    const field = fieldFor(name, node, need.has(name), name, true);
    if (typeof field === "string") return { supported: false, fields: [], reason: field };
    fields.push(field);
  }
  return { supported: true, fields };
}

// ---- Building the op input from form values -----------------------------------------------------------

export type FormValue = string | boolean | Record<string, string | boolean>;

export interface BuiltInput {
  input: Record<string, unknown>;
  errors: string[];
}

const TEMPLATE = /\{\{[^}]*\}\}/;

function readScalar(
  field: FormField,
  raw: unknown,
  label: string,
  errors: string[],
): { present: boolean; value?: unknown } {
  if (field.kind === "boolean") {
    // Untouched means "use the default": omit it, unless the op requires the field.
    if (raw === undefined) {
      return field.required ? { present: true, value: field.default ?? false } : { present: false };
    }
    const value = raw === true;
    // A boolean left at its default is omitted, so the spec stays as small as the author's intent.
    return value === (field.default ?? false) && !field.required
      ? { present: false }
      : { present: true, value };
  }
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return { present: false };
  if (field.kind === "number" || field.kind === "integer") {
    // A reference is kept as text; the run substitutes it and the engine converts the number.
    if (TEMPLATE.test(text)) return { present: true, value: text };
    const n = Number(text);
    if (!Number.isFinite(n)) {
      errors.push(`${label} must be a number`);
      return { present: false };
    }
    if (field.kind === "integer" && !Number.isInteger(n)) {
      errors.push(`${label} must be an integer`);
      return { present: false };
    }
    return { present: true, value: n };
  }
  if (field.kind === "enum") {
    const match = (field.options ?? []).find((option) => String(option) === text);
    if (match === undefined) {
      errors.push(`${label} must be one of: ${(field.options ?? []).join(", ")}`);
      return { present: false };
    }
    return { present: true, value: match };
  }
  if (field.kind === "text_list") {
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    return lines.length > 0 ? { present: true, value: lines } : { present: false };
  }
  return { present: true, value: typeof raw === "string" ? raw : text };
}

/** Turns form values into the op's input, reporting every problem by field. Empty optional fields are omitted. */
export function buildOpInput(plan: OpFormPlan, values: Record<string, FormValue>): BuiltInput {
  const errors: string[] = [];
  const entries: [string, unknown][] = [];
  const own = (record: object, key: string): unknown =>
    Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined;

  for (const field of plan.fields) {
    const raw = own(values, field.name);
    if (field.kind === "object") {
      const given = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const childEntries: [string, unknown][] = [];
      for (const child of field.children ?? []) {
        const read = readScalar(
          child,
          own(given, child.name),
          `${field.label}.${child.name}`,
          errors,
        );
        if (read.present) childEntries.push([child.name, read.value]);
      }
      if (childEntries.length > 0 || field.required) {
        for (const child of field.children ?? []) {
          if (child.required && !childEntries.some(([name]) => name === child.name)) {
            if (!errors.some((e) => e.startsWith(`${field.label}.${child.name} `))) {
              errors.push(`${field.label}.${child.name} is required`);
            }
          }
        }
      }
      // A required object is sent even when every part of it was left at its default.
      if (childEntries.length > 0 || field.required) {
        entries.push([field.name, Object.fromEntries(childEntries)]);
      }
      continue;
    }
    const read = readScalar(field, raw, field.label, errors);
    if (read.present) entries.push([field.name, read.value]);
    else if (field.required && !errors.some((e) => e.startsWith(`${field.label} `))) {
      errors.push(`${field.label} is required`);
    }
  }
  // fromEntries defines own properties, so a schema property named __proto__ cannot set a prototype.
  return { input: Object.fromEntries(entries), errors };
}

// ---- The tool itself ----------------------------------------------------------------------------------

export interface ComponentToolFormInput {
  name: string;
  use: string;
  op: string;
  with?: Record<string, unknown>;
  config?: Record<string, string>;
  /** Slot to `${ENV}`; an empty value keeps the component's default variable. */
  secrets?: Record<string, string>;
  requiresApproval?: boolean;
  extract?: string;
}

export interface ComponentToolFormResult {
  success: boolean;
  tool?: Tool;
  errors?: string[];
}

const nonEmpty = (record: Record<string, string> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(record ?? {}).filter(([, value]) => value.trim() !== ""));

export function buildComponentToolFromForm(input: ComponentToolFormInput): ComponentToolFormResult {
  const config = nonEmpty(input.config);
  const secrets = nonEmpty(input.secrets);
  const candidate = {
    name: input.name,
    action: "component" as const,
    use: input.use,
    op: input.op,
    ...(input.with && Object.keys(input.with).length > 0 && { with: input.with }),
    ...(Object.keys(config).length > 0 && { config }),
    ...(Object.keys(secrets).length > 0 && { secrets }),
    ...(input.requiresApproval !== undefined && { requires_approval: input.requiresApproval }),
    ...(input.extract !== undefined && input.extract !== "" && { extract: input.extract }),
  };
  const result = toolSchema.safeParse(candidate);
  if (!result.success) {
    return { success: false, errors: result.error.issues.map((issue) => issue.message) };
  }
  return { success: true, tool: result.data };
}

/** The raw-YAML fallback for `with`: a mapping, never an alias, empty text meaning no input. */
export function parseWithYaml(text: string): { value?: Record<string, unknown>; error?: string } {
  if (text.trim() === "") return { value: {} };
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { error: doc.errors[0]!.message };
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 0 });
  } catch {
    return { error: "YAML aliases and anchors are not allowed here" };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { error: "must be a YAML mapping (name: value lines)" };
  }
  return { value: data as Record<string, unknown> };
}

// ---- Typed references to earlier steps' outputs --------------------------------------------------------

export interface OutputReferenceOption {
  /** The text to put in a field. */
  reference: string;
  label: string;
}

/**
 * The `{{ step.field }}` references the engine can resolve from earlier component tool steps. Only
 * top-level scalar fields qualify (the engine flattens a step's output the same way), and a tool that
 * sets `extract` is skipped because its output no longer has the op's declared shape.
 */
export function outputReferenceOptions(
  spec: AgentSpec,
  catalog: ComponentCatalogEntry[],
): OutputReferenceOption[] {
  const options: OutputReferenceOption[] = [];
  for (const step of spec.agent.workflow) {
    if (!("type" in step) || step.type !== "tool") continue;
    const tool = spec.agent.tools?.find((t) => t.name === step.tool);
    if (!tool || tool.action !== "component" || tool.extract !== undefined) continue;
    const at = tool.use.lastIndexOf("@");
    const entry = catalog.find(
      (c) => c.id === tool.use.slice(0, at) && c.version === tool.use.slice(at + 1),
    );
    const output =
      entry && Object.hasOwn(entry.ops, tool.op) ? entry.ops[tool.op]?.output : undefined;
    if (output?.type !== "object") continue;
    for (const [name, node] of Object.entries(output.properties ?? {})) {
      if (node.type === "object" || node.type === "array") continue;
      options.push({
        reference: `{{ ${step.step}.${name} }}`,
        label: `${step.step}.${name} (${node.type})`,
      });
    }
  }
  return options;
}
