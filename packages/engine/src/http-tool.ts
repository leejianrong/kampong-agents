import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Tool } from "@kampong/spec";

// The HTTP tool wrapper (PLAN.md Shape S3, SLICES.md V2 KAN-1103): maps an
// AgentSpec `http_request` tool to both (a) a plain async function the
// engine's own workflow executor calls directly for the
// `execute_tool(name)` condition-branch syntax, and (b) a Mastra `Tool`
// definition (createTool) satisfying the literal "tools[] -> Mastra tool
// definitions" mapping ADR-0003 calls for, in case a future slice lets the
// model call tools directly via Mastra's own tool-calling loop.

export function substitutePlaceholders(template: string, params: Record<string, string>): string {
  // Resolves both `{{ step.field }}` (KAN-1429, with optional surrounding
  // spaces) and the original `{step.field}` form, so old specs and the new
  // data-reference syntax both work. The dot is allowed so a workflow.ts-
  // namespaced param like `step_name.field` (see buildToolParams) resolves --
  // params keys are plain strings, a single flat lookup, not dot-path
  // traversal (contrast extractField below). A key with no matching param is
  // left verbatim -- an honest miss, not a guess.
  return template.replace(
    /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}|\{([A-Za-z0-9_.]+)\}/g,
    (match, doubleKey: string | undefined, singleKey: string | undefined) => {
      const key = doubleKey ?? singleKey!;
      return key in params ? params[key]! : match;
    },
  );
}

// KAN-1430 (ADR-0021): resolve a connector's `${ENV_VAR}` credential token to
// its value at call time -- never a literal in the spec (schema enforces the
// placeholder form). A missing env var fails loudly, like the model-key path.
export function resolveEnvValue(placeholder: string, env: NodeJS.ProcessEnv): string {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(placeholder);
  if (!match) return placeholder;
  const name = match[1]!;
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `Environment variable ${name} is not set (required for a connector credential).`,
    );
  }
  return value;
}

// KAN-1845: `${ENV_VAR}` anywhere inside a larger string (a header like "Bearer ${TOKEN}", a query
// value, a body field). Each resolved value is pushed onto `secrets` so it is redacted from fixtures
// and error messages. Run this on the author-written template BEFORE data references are
// substituted: data (model output, a webhook body) is untrusted and must never be able to smuggle a
// `${SOME_SECRET}` into a request.
const ENV_IN_TEXT = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function resolveEnvInText(text: string, env: NodeJS.ProcessEnv, secrets: string[]): string {
  return text.replace(ENV_IN_TEXT, (_match, name: string) => {
    const value = env[name];
    if (value === undefined || value === "") {
      throw new Error(`Environment variable ${name} is not set (referenced in a request field).`);
    }
    secrets.push(value);
    return value;
  });
}

export function redactSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export type ResponseMode = "json" | "text" | "bytes";

export interface ToolRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** How the response is read; defaults to JSON (the original behaviour). */
  responseMode: ResponseMode;
  extract?: string;
  /** Resolved secret values (e.g. a bearer token) to keep out of any fixture. */
  secrets: string[];
}

/**
 * Builds the concrete HTTP request for a tool of any kind (KAN-1430). The
 * generic `http_request` tool is a URL + method as before; the `slack`/`gmail`
 * connectors translate their structured fields into the provider's real API
 * call, with the resolved `${ENV}` token in an `Authorization` header (never
 * in the URL or body, so the fixture layer -- which records URL + response
 * body, not request headers -- can't leak it). Every user string field is run
 * through `substitutePlaceholders` so `{{ step.field }}` references resolve.
 */
export function buildToolRequest(
  tool: Tool,
  params: Record<string, string>,
  env: NodeJS.ProcessEnv,
): ToolRequest {
  const sub = (text: string) => substitutePlaceholders(text, params);
  switch (tool.action) {
    case "http_request":
      return buildHttpRequest(tool, sub, env);
    case "slack_post_message": {
      const token = resolveEnvValue(tool.token, env);
      return {
        url: "https://slack.com/api/chat.postMessage",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel: sub(tool.channel), text: sub(tool.text) }),
        responseMode: "json",
        extract: tool.extract,
        secrets: [token],
      };
    }
    case "gmail_send": {
      const token = resolveEnvValue(tool.token, env);
      const mime = [
        `To: ${sub(tool.to)}`,
        `Subject: ${sub(tool.subject)}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "",
        sub(tool.body),
      ].join("\r\n");
      const raw = Buffer.from(mime, "utf8").toString("base64url");
      return {
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
        responseMode: "json",
        extract: tool.extract,
        secrets: [token],
      };
    }
  }
}

type HttpRequestTool = Extract<Tool, { action: "http_request" }>;

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function buildHttpRequest(
  tool: HttpRequestTool,
  sub: (text: string) => string,
  env: NodeJS.ProcessEnv,
): ToolRequest {
  const secrets: string[] = [];
  // Order matters (see ENV_IN_TEXT): resolve `${ENV}` in the author's template first, then
  // substitute data references into the result.
  const resolve = (text: string): string => sub(resolveEnvInText(text, env, secrets));

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(tool.headers ?? {})) {
    headers[name] = resolve(value);
  }

  let url = resolve(tool.url);
  const query = Object.entries(tool.query ?? {});
  if (query.length > 0) {
    const encoded = query
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(resolve(value))}`)
      .join("&");
    url += `${url.includes("?") ? "&" : "?"}${encoded}`;
  }

  const responseMode: ResponseMode = tool.response?.mode ?? "json";
  if (tool.extract !== undefined && responseMode !== "json") {
    throw new Error(
      `Tool "${tool.name}" sets extract, which only applies to a json response (response mode is "${responseMode}").`,
    );
  }

  let body: string | undefined;
  if (tool.body !== undefined) {
    if (tool.method === "GET") {
      throw new Error(`Tool "${tool.name}" has a body, which a GET request cannot send.`);
    }
    if ("json" in tool.body) {
      body = JSON.stringify(mapStrings(tool.body.json, resolve));
      if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
    } else if ("form" in tool.body) {
      const form = new URLSearchParams();
      for (const [name, value] of Object.entries(tool.body.form)) form.append(name, resolve(value));
      body = form.toString();
      if (!hasHeader(headers, "content-type")) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
    } else {
      body = resolve(tool.body.raw);
      if (!hasHeader(headers, "content-type")) {
        headers["Content-Type"] = tool.body.content_type ?? "text/plain; charset=utf-8";
      }
    }
  }

  return {
    url,
    method: tool.method,
    headers,
    ...(body !== undefined ? { body } : {}),
    responseMode,
    extract: tool.extract,
    secrets,
  };
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        mapStrings(entry, fn),
      ]),
    );
  }
  return value;
}

export function extractField(payload: unknown, path?: string): unknown {
  if (!path) return payload;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, payload);
}

// Context about which AgentSpec tool a call belongs to, passed alongside
// the request rather than smuggled into it. `tool.name` is an
// author-controlled string (schema only requires `z.string().min(1)` --
// no character restriction), so it must never end up as a literal HTTP
// header value on a call that can reach a real third-party endpoint: the
// Headers/ByteString conversion throws a `TypeError` on a newline or any
// non-Latin1 character, and even a "safe" name is an internal
// implementation detail no remote API asked for. Consumers that need the
// tool name (the mock/record fixture layer -- tool-fixtures.ts) receive it
// as this explicit third argument instead.
export interface ToolContext {
  readonly toolName: string;
}

// The `fetchImpl` seam used specifically for *tool* HTTP calls. Distinct
// from plain `typeof fetch` (which the model-call path still uses
// unchanged) so the mock/record layer can be told which tool a call
// belongs to without reading it back off the request itself. A function
// declaring fewer parameters (e.g. the global `fetch`, or a test's plain
// `(url, init) => ...` fake) is assignable here -- TS allows a callback
// with fewer declared params than the type it's assigned to, since the
// runtime call always tolerates extra ignored arguments.
export type ToolFetchImpl = (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] | undefined,
  context: ToolContext,
) => Promise<Response>;

const defaultFetch: ToolFetchImpl = (input, init) => fetch(input, init);

export interface HttpToolCallOptions {
  fetchImpl?: ToolFetchImpl;
  /** Resolves connector `${ENV}` tokens (KAN-1430). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds the tool's concrete request (generic HTTP or a connector, KAN-1430),
 * performs the call with any auth headers and body, and extracts the configured
 * response field. A non-2xx response or network error surfaces as a rejected
 * promise with the tool's name in the message, so a failed tool call halts the
 * run and reports which step failed (PLAN.md "Failure behavior") rather than
 * continuing silently.
 */
export async function callHttpTool(
  tool: Tool,
  params: Record<string, string>,
  { fetchImpl = defaultFetch, env = process.env }: HttpToolCallOptions = {},
): Promise<unknown> {
  const request = buildToolRequest(tool, params, env);
  let response: Response;
  try {
    response = await fetchImpl(
      request.url,
      {
        method: request.method,
        ...(Object.keys(request.headers).length > 0 ? { headers: request.headers } : {}),
        ...(request.body !== undefined ? { body: request.body } : {}),
      },
      { toolName: tool.name },
    );
  } catch (err) {
    // The URL can carry a resolved query-string secret (KAN-1845), so it is redacted everywhere it
    // is reported.
    throw new Error(
      redactSecrets(
        `Tool "${tool.name}" HTTP call to ${request.url} failed: ${(err as Error).message}`,
        request.secrets,
      ),
      { cause: err },
    );
  }
  if (!response.ok) {
    throw new Error(
      redactSecrets(
        `Tool "${tool.name}" HTTP call to ${request.url} failed: ${response.status} ${response.statusText}`,
        request.secrets,
      ),
    );
  }
  if (request.responseMode === "text") return response.text();
  // Bytes are returned base64-encoded so the value stays a plain string in step outputs.
  if (request.responseMode === "bytes") {
    return Buffer.from(await response.arrayBuffer()).toString("base64");
  }
  const body: unknown = await response.json();
  return extractField(body, request.extract);
}

export function toMastraTool(tool: Tool, options: HttpToolCallOptions = {}) {
  return createTool({
    id: tool.name,
    description: `Tool "${tool.name}" (AgentSpec ${tool.action} tool).`,
    inputSchema: z.record(z.string(), z.string()),
    execute: async (inputData) => callHttpTool(tool, inputData, options),
  });
}
