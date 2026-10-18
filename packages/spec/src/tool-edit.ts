import { stringify } from "yaml";
import type { FormValue, OpFormPlan } from "./component-form.js";
import type { PatchOp } from "./mutate.js";
import type { RequestBody, ResponseMode } from "./request.js";
import type { Tool } from "./schema.js";
import { diffPatch } from "./step-edit.js";

// Editing a tool that is already in `agent.tools` (KAM-175). The Add Tool forms are reused, so this file only
// holds what an edit needs beyond them: the form's starting values from the tool as written, and a patch that
// touches only the fields that changed (so comments, key order and styles elsewhere in the tool are kept).

type HttpTool = Extract<Tool, { action: "http_request" }>;
type ComponentTool = Extract<Tool, { action: "component" }>;

const lines = (record: Record<string, string> | undefined, separator: ":" | "=") =>
  Object.entries(record ?? {})
    .map(([name, value]) => (separator === ":" ? `${name}: ${value}` : `${name}=${value}`))
    .join("\n");

export interface HttpToolDraft {
  method: string;
  url: string;
  headers: string;
  query: string;
  bodyType: "none" | "json" | "form" | "raw";
  bodyContent: string;
  bodyContentType: string;
  responseMode: ResponseMode;
  extract: string;
}

/** The Add Tool form's text for an existing HTTP tool: headers as `name: value` lines, query as `name=value`. */
export function httpToolToDraft(tool: HttpTool): HttpToolDraft {
  const body: RequestBody | undefined = tool.body;
  let bodyType: HttpToolDraft["bodyType"] = "none";
  let bodyContent = "";
  let bodyContentType = "";
  if (body && "json" in body) {
    bodyType = "json";
    bodyContent = JSON.stringify(body.json, null, 2);
  } else if (body && "form" in body) {
    bodyType = "form";
    bodyContent = lines(body.form, "=");
  } else if (body) {
    bodyType = "raw";
    bodyContent = body.raw;
    bodyContentType = body.content_type ?? "";
  }
  return {
    method: tool.method,
    url: tool.url,
    headers: lines(tool.headers, ":"),
    query: lines(tool.query, "="),
    bodyType,
    bodyContent,
    bodyContentType,
    responseMode: tool.response?.mode ?? "json",
    extract: tool.extract ?? "",
  };
}

/**
 * Form values for an op's saved `with` input, or the reason the form cannot show it. A value the form's field
 * would change on a round trip (a number where the op declares text, say) is refused, so the caller falls back
 * to editing the input as YAML instead of rewriting it silently.
 */
export function withToFormValues(
  plan: OpFormPlan,
  input: Record<string, unknown> | undefined,
): { values: Record<string, FormValue> } | { reason: string } {
  const given = input ?? {};
  const values: Record<string, FormValue> = {};
  const scalar = (field: OpFormPlan["fields"][number], raw: unknown): string | boolean | null => {
    if (field.kind === "boolean") return typeof raw === "boolean" ? raw : null;
    if (field.kind === "text_list") {
      return Array.isArray(raw) && raw.every((v) => typeof v === "string")
        ? (raw as string[]).join("\n")
        : null;
    }
    if (field.kind === "number" || field.kind === "integer") {
      return typeof raw === "number" || typeof raw === "string" ? String(raw) : null;
    }
    if (field.kind === "enum") {
      return typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : null;
    }
    return typeof raw === "string" ? raw : null;
  };
  for (const field of plan.fields) {
    if (!Object.hasOwn(given, field.name)) continue;
    const raw = given[field.name];
    if (field.kind === "object") {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return { reason: `${field.name} is not an object` };
      }
      const record: Record<string, string | boolean> = {};
      for (const child of field.children ?? []) {
        if (!Object.hasOwn(raw, child.name)) continue;
        const value = scalar(child, (raw as Record<string, unknown>)[child.name]);
        if (value === null) return { reason: `${field.name}.${child.name} has an unexpected type` };
        record[child.name] = value;
      }
      values[field.name] = record;
      continue;
    }
    const value = scalar(field, raw);
    if (value === null) return { reason: `${field.name} has an unexpected type` };
    values[field.name] = value;
  }
  return { values };
}

/** `with` as YAML text, for an op whose input the form cannot show. */
export function withToYaml(input: Record<string, unknown> | undefined): string {
  return input && Object.keys(input).length > 0 ? stringify(input).trimEnd() : "";
}

/** The HTTP fields the Add Tool form has no control for; an edit keeps them as written. */
const HTTP_KEPT = ["requires_approval", "failure_when", "pace", "retry"] as const;
const FORM_KEPT = ["requires_approval"] as const;

/**
 * The patch that turns the tool at `path` into what the form built. Fields the form has no control for
 * (an HTTP tool's `failure_when`, `pace` and `retry`; a Slack or Gmail tool's `requires_approval`) are copied from
 * the saved tool first, so saving the form never drops them. For a component tool the `with` of a boolean the form
 * left at its default is kept if it was written out.
 */
export function toolEditPatch(path: (string | number)[], before: Tool, built: Tool): PatchOp[] {
  const kept: readonly string[] =
    before.action === "http_request" ? HTTP_KEPT : before.action === "component" ? [] : FORM_KEPT;
  const after: Record<string, unknown> = { ...built };
  for (const key of kept) {
    const value = (before as Record<string, unknown>)[key];
    if (value !== undefined && !(key in after)) after[key] = value;
  }
  // An explicit `response: { mode: json }` is the default the form leaves out; it is not a change.
  if (
    before.action === "http_request" &&
    !("response" in after) &&
    before.response?.mode === "json"
  ) {
    after.response = before.response;
  }
  // The name is never edited here (a rename also has to change the steps that call the tool).
  after.name = before.name;
  return diffPatch(path, before, after);
}

/** For a component tool: `with` plus what the form could not express, in the order the tool had it. */
export function mergeWith(
  plan: OpFormPlan,
  before: ComponentTool,
  built: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...built };
  for (const [key, value] of Object.entries(before.with ?? {})) {
    if (key in out) continue;
    const field = plan.fields.find((f) => f.name === key);
    if (!field) out[key] = value;
    else if (field.kind === "boolean" && value === (field.default ?? false)) out[key] = value;
  }
  return out;
}
