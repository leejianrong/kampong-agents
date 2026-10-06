// Vendored from packages/engine/src/http-tool.ts as part of a `kampong export`
// -- see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. The
// only change from the source file is the type import, which now comes from
// the local ./spec-types.js rather than "@kampong/spec" (this project has no
// dependency on that package -- ADR-0002). From here on this file is yours: it
// will not be touched again by a future export.
//
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Tool } from "./spec-types.js";
import { defaultPacer, realClock, type Clock, type Pacer } from "./pacing.js";
import { mapStringsDeep, redactString } from "./redact.js";

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
// value, a body field); `$${NAME}` is an escape that yields the literal text `${NAME}`. Each
// resolved value is pushed onto `secrets` so it is redacted from fixtures and error messages.
//
// The template is tokenised: author-written literal parts get data references substituted, env
// references are replaced verbatim. So data (model output, a webhook body) can never smuggle a
// `${SOME_SECRET}` into a request, and a secret that happens to contain `{word}` is never rewritten
// by data substitution.
const ENV_TOKEN = /\$\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function resolveTemplate(
  text: string,
  env: NodeJS.ProcessEnv,
  secrets: string[],
  substitute: (literal: string) => string,
): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(ENV_TOKEN)) {
    out += substitute(text.slice(last, match.index));
    last = match.index + match[0].length;
    const escaped = match[1];
    if (escaped !== undefined) {
      out += `\${${escaped}}`;
      continue;
    }
    const name = match[2]!;
    const value = env[name];
    if (value === undefined || value === "") {
      throw new Error(`Environment variable ${name} is not set (referenced in a request field).`);
    }
    secrets.push(value);
    out += value;
  }
  return out + substitute(text.slice(last));
}

export type ResponseMode = "json" | "text" | "bytes";

export type FailureRule = NonNullable<HttpRequestTool["failure_when"]>[number];
export type RetryPolicy = NonNullable<HttpRequestTool["retry"]>;

// ADR-0029: one error shape for a tool call. `retryable` is what the retry policy keys on.
export type ToolErrorCode =
  "input" | "permission" | "auth" | "rate_limit" | "failure_when" | "http" | "timeout";

export class ToolCallError extends Error {
  constructor(
    message: string,
    public readonly code: ToolErrorCode,
    public readonly retryable: boolean,
    public readonly status?: number,
    /** From a Retry-After header, when the server sent one. */
    public readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolCallError";
  }
}

export interface ToolRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** How the response is read; defaults to JSON (the original behaviour). */
  responseMode: ResponseMode;
  failureWhen?: FailureRule[];
  pace?: { rps: number };
  retry?: RetryPolicy;
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
    case "component":
      // A component call needs its manifest and runner, so it goes through invokeOp (component.ts),
      // never through this builder.
      throw new ToolCallError(
        `Tool "${tool.name}" is a component call and must run through the component registry`,
        "input",
        false,
      );
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
  // See ENV_TOKEN: data is substituted only into the author's literal text, env values are
  // inserted verbatim.
  const resolve = (text: string): string => resolveTemplate(text, env, secrets, sub);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(tool.headers ?? {})) {
    headers[name] = resolve(value);
  }

  let url = resolve(tool.url);
  const query = Object.entries(tool.query ?? {});
  if (query.length > 0) {
    // The URL API places the query before any #fragment and handles an existing or trailing `?`.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(
        redactString(
          `Tool "${tool.name}" has query parameters but its url is not a valid URL: ${url}`,
          secrets,
        ),
      );
    }
    for (const [name, value] of query) parsed.searchParams.append(name, resolve(value));
    url = parsed.toString();
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
      body = JSON.stringify(mapStringsDeep(tool.body.json, resolve));
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
    ...(tool.failure_when ? { failureWhen: tool.failure_when } : {}),
    ...(tool.pace ? { pace: tool.pace } : {}),
    ...(tool.retry ? { retry: tool.retry } : {}),
    extract: tool.extract,
    secrets,
  };
}

export function extractField(payload: unknown, path?: string): unknown {
  if (!path) return payload;
  // Same path syntax as failure_when (dotted keys, ["quoted keys"], [n] indexes).
  return readResponsePath(payload, path);
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
  /**
   * Resolved secret values this request carries (KAN-1845), so the mock/record layer can redact
   * them from what it persists without being told about every credential up front.
   */
  readonly secrets?: readonly string[];
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
  /** Paces `pace: { rps }` tools; one process-wide pacer by default (KAN-1846). */
  pacer?: Pacer;
  /** Time source for retry delays; real timers by default. */
  clock?: Clock;
}

// KAN-1846: a response path is dotted keys, ["quoted keys"] and [n] indexes (ADR-0029). Returns
// `undefined` for any step that does not resolve. The syntax is validated at spec load, so a
// malformed path here means a hand-built tool; treat it as "does not resolve".
export function readResponsePath(payload: unknown, path: string): unknown {
  const steps = [...path.matchAll(/\["((?:[^"\\]|\\.)*)"\]|\[(\d+)\]|([A-Za-z0-9_$-]+)/g)];
  let current: unknown = payload;
  for (const step of steps) {
    if (current === null || typeof current !== "object") return undefined;
    const key = step[1] !== undefined ? step[1].replace(/\\(.)/g, "$1") : (step[2] ?? step[3]!);
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function ruleFires(rule: FailureRule, body: unknown): boolean {
  const value = readResponsePath(body, rule.path);
  if (rule.exists !== undefined) {
    const present = value !== undefined && value !== null;
    return rule.exists === present;
  }
  if (rule.equals !== undefined) return value === rule.equals;
  if (rule.matches !== undefined) {
    if (typeof value !== "string") return false;
    try {
      return new RegExp(rule.matches).test(value);
    } catch {
      // Spec validation rejects a bad pattern; this guards a hand-built tool.
      throw new ToolCallError(
        `failure_when rule has an invalid pattern: ${rule.matches}`,
        "input",
        false,
      );
    }
  }
  return false;
}

function describeRule(rule: FailureRule): string {
  if (rule.exists !== undefined) {
    return `"${rule.path}" ${rule.exists ? "is present" : "is missing"}`;
  }
  if (rule.equals !== undefined) return `"${rule.path}" equals ${JSON.stringify(rule.equals)}`;
  return `"${rule.path}" matches /${rule.matches}/`;
}

// Retry-After is either delta-seconds or an HTTP date.
function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function statusError(
  tool: Tool,
  request: ToolRequest,
  response: Response,
  clock: Clock,
): ToolCallError {
  const { status } = response;
  const code: ToolErrorCode =
    status === 429
      ? "rate_limit"
      : status === 401 || status === 403
        ? "auth"
        : status === 408
          ? "timeout"
          : "http";
  const retryable = status === 429 || status === 408 || status >= 500;
  return new ToolCallError(
    redactString(
      `Tool "${tool.name}" HTTP call to ${request.url} failed: ${status} ${response.statusText}`,
      request.secrets,
    ),
    code,
    retryable,
    status,
    parseRetryAfter(response.headers.get("retry-after"), clock.now()),
  );
}

async function attemptHttpCall(
  tool: Tool,
  request: ToolRequest,
  fetchImpl: ToolFetchImpl,
  clock: Clock,
): Promise<unknown> {
  let response: Response;
  // A request that carries a resolved secret must not be handed to another host by a redirect: fetch
  // would resend custom credential headers (only Authorization and Cookie are stripped across
  // origins). So redirects are followed here, by hand, and only within the original origin.
  const credentialed = request.secrets.length > 0;
  let url = request.url;
  let method = request.method;
  let outgoingBody = request.body;
  try {
    for (let hops = 0; ; hops += 1) {
      response = await fetchImpl(
        url,
        {
          method,
          ...(Object.keys(request.headers).length > 0 ? { headers: request.headers } : {}),
          ...(outgoingBody !== undefined ? { body: outgoingBody } : {}),
          ...(credentialed ? { redirect: "manual" as const } : {}),
        },
        { toolName: tool.name, secrets: request.secrets },
      );
      const location = response.headers.get("location");
      if (!credentialed || !REDIRECT_STATUSES.has(response.status) || location === null) break;
      const next = new URL(location, url);
      if (next.origin !== new URL(url).origin) {
        throw new ToolCallError(
          redactString(
            `Tool "${tool.name}" HTTP call to ${request.url} was redirected to another host (${next.origin}); ` +
              `a request carrying credentials does not follow cross-origin redirects`,
            request.secrets,
          ),
          "http",
          false,
          response.status,
        );
      }
      if (hops >= MAX_REDIRECTS) {
        throw new ToolCallError(
          `Tool "${tool.name}" HTTP call to ${next.origin} followed too many redirects`,
          "http",
          false,
          response.status,
        );
      }
      // The browser rules: 303, and 301/302 after a POST, become a GET with no body.
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET";
        outgoingBody = undefined;
      }
      url = next.toString();
    }
  } catch (err) {
    if (err instanceof ToolCallError) throw err;
    // The URL can carry a resolved query-string secret (KAN-1845), and the original error travels
    // on as `cause`, so both are scrubbed before being reported or attached.
    if (err instanceof Error) {
      err.message = redactString(err.message, request.secrets);
      if (err.stack) err.stack = redactString(err.stack, request.secrets);
    }
    throw new ToolCallError(
      redactString(
        `Tool "${tool.name}" HTTP call to ${request.url} failed: ${(err as Error).message}`,
        request.secrets,
      ),
      "http",
      true,
      undefined,
      undefined,
      { cause: err },
    );
  }
  if (!response.ok) throw statusError(tool, request, response, clock);
  if (request.responseMode === "text") return response.text();
  // Bytes are returned base64-encoded so the value stays a plain string in step outputs.
  if (request.responseMode === "bytes") {
    return Buffer.from(await response.arrayBuffer()).toString("base64");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    // A rate limiter or proxy often answers 200 with an HTML page; classify it like any other
    // transient failure instead of surfacing a bare SyntaxError.
    throw new ToolCallError(
      redactString(
        `Tool "${tool.name}" HTTP call to ${request.url} returned a body that is not valid JSON`,
        request.secrets,
      ),
      "http",
      true,
      response.status,
      undefined,
      { cause: err },
    );
  }
  for (const rule of request.failureWhen ?? []) {
    if (!ruleFires(rule, body)) continue;
    const reason =
      rule.message_path !== undefined ? readResponsePath(body, rule.message_path) : undefined;
    const rawDetail =
      reason !== undefined && reason !== null
        ? typeof reason === "string"
          ? reason
          : JSON.stringify(reason)
        : describeRule(rule);
    // A whole error payload or an HTML page must not become an enormous error message.
    const detail = rawDetail.length > 300 ? `${rawDetail.slice(0, 300)}...` : rawDetail;
    throw new ToolCallError(
      redactString(
        `Tool "${tool.name}" HTTP call to ${request.url} reported a failure: ${detail}`,
        request.secrets,
      ),
      "failure_when",
      rule.retryable ?? false,
    );
  }
  return extractField(body, request.extract);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

// A POST or PATCH may already have been processed when a 5xx or a dropped connection comes back, so
// retrying it could repeat a side effect. A 429 means the server refused it before acting, which is
// safe for every method.
function mayRetry(error: ToolCallError, method: string): boolean {
  if (!error.retryable) return false;
  if (error.code === "rate_limit") return true;
  // An author who marks a rule `retryable: true` is stating that this response means the request was
  // refused (an `ok:false, error:"ratelimited"` body), so that opt-in holds for any method.
  if (error.code === "failure_when") return true;
  return ["GET", "HEAD", "PUT", "DELETE"].includes(method.toUpperCase());
}

/**
 * Builds the tool's concrete request (generic HTTP or a connector, KAN-1430),
 * performs the call with any auth headers and body, and extracts the configured
 * response field. A non-2xx response, a `failure_when` rule firing, or a network
 * error surfaces as a rejected `ToolCallError` with the tool's name in the
 * message, so a failed tool call halts the run and reports which step failed
 * (PLAN.md "Failure behavior") rather than continuing silently. With a `retry`
 * policy, retryable failures are re-attempted with backoff (KAN-1846).
 */
export async function callHttpTool(
  tool: Tool,
  params: Record<string, string>,
  {
    fetchImpl = defaultFetch,
    env = process.env,
    pacer = defaultPacer,
    clock = realClock,
  }: HttpToolCallOptions = {},
): Promise<unknown> {
  const request = buildToolRequest(tool, params, env);
  const paceKey = (() => {
    try {
      return new URL(request.url).host;
    } catch {
      return tool.name;
    }
  })();
  const policy = request.retry;
  const maxAttempts = 1 + (policy?.max ?? 0);

  for (let attempt = 1; ; attempt += 1) {
    if (request.pace) await pacer.wait(paceKey, request.pace.rps);
    try {
      return await attemptHttpCall(tool, request, fetchImpl, clock);
    } catch (err) {
      if (!(err instanceof ToolCallError) || !policy || !mayRetry(err, request.method)) throw err;
      if (attempt >= maxAttempts) {
        throw new ToolCallError(
          `${err.message} (after ${attempt} attempts)`,
          err.code,
          err.retryable,
          err.status,
          err.retryAfterMs,
          { cause: err },
        );
      }
      const base = policy.base_ms ?? DEFAULT_RETRY_BASE_MS;
      const backoff = policy.backoff === "fixed" ? base : base * 2 ** (attempt - 1);
      const cap = policy.max_delay_ms ?? DEFAULT_RETRY_MAX_DELAY_MS;
      if (err.retryAfterMs !== undefined && err.retryAfterMs > cap) {
        throw new ToolCallError(
          `${err.message} (server asked to wait ${Math.round(err.retryAfterMs / 1000)}s via Retry-After, ` +
            `longer than max_delay_ms ${cap}ms; not retrying)`,
          err.code,
          false,
          err.status,
          err.retryAfterMs,
          { cause: err },
        );
      }
      await clock.sleep(Math.min(Math.max(backoff, err.retryAfterMs ?? 0), cap));
    }
  }
}

export function toMastraTool(tool: Tool, options: HttpToolCallOptions = {}) {
  return createTool({
    id: tool.name,
    description: `Tool "${tool.name}" (AgentSpec ${tool.action} tool).`,
    inputSchema: z.record(z.string(), z.string()),
    execute: async (inputData) => callHttpTool(tool, inputData, options),
  });
}
