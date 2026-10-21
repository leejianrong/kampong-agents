import type { RequestBody, ResponseMode } from "./request.js";
import { toolSchema, type Tool } from "./schema.js";

// The "Add Tool" affordance (PLAN.md Affordances, Q12/R5): a structured
// form — name, HTTP method, URL with {placeholders}, response-extraction
// path — is the primary, zero-LLM-calls path for defining a tool.
// Natural-language-assisted drafting, if it ever ships, is a layer on top
// of this, not a replacement for it.

// `kind` discriminates which tool the form builds; it defaults to
// "http_request" when omitted, so every pre-existing caller keeps building a
// generic HTTP tool exactly as before. KAN-1430 adds the Slack/Gmail connector
// shapes, whose `token` is an ${ENV} placeholder.
export interface HttpToolFormInput {
  kind?: "http_request";
  name: string;
  method: string;
  url: string;
  // KAN-1845: the shared request description. Empty values are dropped so a spec that does not use
  // them serialises exactly as before.
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: RequestBody;
  response?: { mode: ResponseMode };
  requiresApproval?: boolean;
  extract?: string;
}

export interface SlackToolFormInput {
  kind: "slack_post_message";
  name: string;
  token: string;
  channel: string;
  text: string;
  requiresApproval?: boolean;
  extract?: string;
}

export interface GmailToolFormInput {
  kind: "gmail_send";
  name: string;
  token: string;
  to: string;
  subject: string;
  body: string;
  requiresApproval?: boolean;
  extract?: string;
}

export type ToolFormInput = HttpToolFormInput | SlackToolFormInput | GmailToolFormInput;

export interface ToolFormResult {
  success: boolean;
  tool?: Tool;
  /** Every problem as one sentence that names its field, in field order, each once. */
  errors?: string[];
  /** The same problems by form field (`name`, `url`, `token`...), so a form can show each beside its field. */
  fieldErrors?: Record<string, string>;
}

// KAM-193: how each form field is called in a message.
const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  method: "Method",
  url: "URL",
  token: "Token",
  channel: "Channel",
  text: "Text",
  to: "To",
  subject: "Subject",
  body: "Body",
};

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why a tool name cannot be used, in a sentence that starts with "Name", or null. A tool is called by this name. */
export function toolNameProblem(name: string): string | null {
  if (name.trim() === "") return "Name is required.";
  if (!TOOL_NAME.test(name)) {
    return (
      "Name can only use letters, digits and underscores, and must start with a letter or an underscore " +
      "(for example fetch_price)."
    );
  }
  return null;
}

// A `{symbol}`, `{{ step.field }}` or `${ENV}` in a URL is filled in at run time, so for the shape check each stands
// in as a plain word.
const PLACEHOLDER = /\$\{[^}]*\}|\{\{[^}]*\}\}|\{[^}]*\}/g;

/** Why a tool's URL cannot be used, in a sentence that starts with "URL", or null. */
export function toolUrlProblem(url: string): string | null {
  const text = url.trim();
  if (text === "") return "URL is required.";
  const shape = text.replace(PLACEHOLDER, "x");
  // A URL that opens with a placeholder (`{{ vars.base }}/v1`, `${BASE_URL}/v1`) has its scheme and host filled in
  // later, so only what can be judged now is judged.
  const opensWithPlaceholder = /^(\$\{|\{)/.test(text);
  if (!opensWithPlaceholder && !/^https?:\/\//i.test(shape)) {
    return "URL must start with http:// or https:// (for example https://api.example.com/items).";
  }
  if (/\s/.test(shape)) return "URL cannot contain spaces.";
  if (!opensWithPlaceholder) {
    try {
      if (new URL(shape).hostname === "") throw new Error("no host");
    } catch {
      return "URL is not a web address: it needs a host after http:// or https://.";
    }
  }
  return null;
}

export function buildToolFromForm(input: ToolFormInput): ToolFormResult {
  const shared = {
    name: input.name,
    ...(input.requiresApproval !== undefined && { requires_approval: input.requiresApproval }),
    ...(input.extract !== undefined && { extract: input.extract }),
  };

  let candidate: unknown;
  if (input.kind === "slack_post_message") {
    candidate = {
      ...shared,
      action: "slack_post_message" as const,
      token: input.token,
      channel: input.channel,
      text: input.text,
    };
  } else if (input.kind === "gmail_send") {
    candidate = {
      ...shared,
      action: "gmail_send" as const,
      token: input.token,
      to: input.to,
      subject: input.subject,
      body: input.body,
    };
  } else {
    candidate = {
      ...shared,
      action: "http_request" as const,
      method: input.method,
      url: input.url,
      ...(input.headers && Object.keys(input.headers).length > 0 && { headers: input.headers }),
      ...(input.query && Object.keys(input.query).length > 0 && { query: input.query }),
      ...(input.body !== undefined && { body: input.body }),
      ...(input.response !== undefined && { response: input.response }),
    };
  }

  // The checks the schema does not make (a name that can be called, a URL that is one) come first, so an empty
  // field is named once; then whatever else the schema says is attached to its field.
  const fieldErrors: Record<string, string> = {};
  const nameProblem = toolNameProblem(input.name);
  if (nameProblem) fieldErrors["name"] = nameProblem;
  if ((input.kind ?? "http_request") === "http_request") {
    const urlProblem = toolUrlProblem((input as HttpToolFormInput).url);
    if (urlProblem) fieldErrors["url"] = urlProblem;
  }
  const result = toolSchema.safeParse(candidate);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = typeof issue.path[0] === "string" ? issue.path[0] : "form";
      if (field in fieldErrors) continue;
      const label = FIELD_LABELS[field];
      // An empty text field is "required" whichever rule the schema tripped first (a min length, a pattern).
      const empty = (candidate as Record<string, unknown>)[field] === "";
      fieldErrors[field] = empty && label ? `${label} is required.` : issue.message;
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { success: false, errors: [...new Set(Object.values(fieldErrors))], fieldErrors };
  }
  if (!result.success) return { success: false, errors: ["Invalid tool definition"] };
  return { success: true, tool: result.data };
}

export interface KeyValueLines {
  values: Record<string, string>;
  errors: string[];
}

/**
 * Parses a textarea of `name<separator>value` lines (HTTP headers use ":", query parameters "=")
 * into a record. Splits on the first separator only, so a value may itself contain it; blank lines
 * are skipped; every malformed line is reported with its 1-based line number.
 */
export function parseKeyValueLines(text: string, separator: ":" | "="): KeyValueLines {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  text.split("\n").forEach((rawLine, index) => {
    if (rawLine.trim() === "") return;
    const at = rawLine.indexOf(separator);
    const name = at === -1 ? "" : rawLine.slice(0, at).trim();
    if (name === "") {
      errors.push(`line ${index + 1}: expected "name${separator}value"`);
      return;
    }
    values[name] = rawLine.slice(at + 1).trim();
  });
  return { values, errors };
}
