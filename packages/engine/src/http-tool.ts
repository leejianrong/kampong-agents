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
  // The dot is allowed here specifically so a workflow.ts-namespaced param
  // like `{step_name.field}` (see buildToolParams) resolves -- params keys
  // are plain strings, not a nested path, so this is a single flat lookup,
  // not dot-path traversal (contrast extractField below).
  return template.replace(/\{([A-Za-z0-9_.]+)\}/g, (match, key: string) => {
    return key in params ? params[key]! : match;
  });
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
}

/**
 * Substitutes `{placeholder}` params into the tool's URL, performs the HTTP
 * call, and extracts the configured response field -- the exact mapping
 * SLICES.md V2's unit test plan names directly. A non-2xx response or
 * network error surfaces as a rejected promise with the tool's name in the
 * message, so a failed tool call halts the run and reports which step
 * failed (PLAN.md "Failure behavior") rather than continuing silently.
 */
export async function callHttpTool(
  tool: Tool,
  params: Record<string, string>,
  { fetchImpl = defaultFetch }: HttpToolCallOptions = {},
): Promise<unknown> {
  const url = substitutePlaceholders(tool.url, params);
  let response: Response;
  try {
    response = await fetchImpl(url, { method: tool.method }, { toolName: tool.name });
  } catch (err) {
    throw new Error(`Tool "${tool.name}" HTTP call to ${url} failed: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(
      `Tool "${tool.name}" HTTP call to ${url} failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  return extractField(body, tool.extract);
}

export function toMastraTool(tool: Tool, options: HttpToolCallOptions = {}) {
  return createTool({
    id: tool.name,
    description: `HTTP ${tool.method} tool "${tool.name}" (AgentSpec http_request tool).`,
    inputSchema: z.record(z.string(), z.string()),
    execute: async (inputData) => callHttpTool(tool, inputData, options),
  });
}
