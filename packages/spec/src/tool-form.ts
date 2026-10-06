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
  errors?: string[];
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

  const result = toolSchema.safeParse(candidate);
  if (!result.success) {
    return { success: false, errors: result.error.issues.map((issue) => issue.message) };
  }
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
