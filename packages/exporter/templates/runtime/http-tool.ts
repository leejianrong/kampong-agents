// Vendored from packages/engine/src/http-tool.ts as part of a `kampong
// export` -- see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md.
// The only change from the source file is the `Tool` type import, which now
// comes from the local ./spec-types.js rather than "@kampong/spec" (this
// project has no dependency on that package -- ADR-0002). From here on this
// file is yours: it will not be touched again by a future export.
//
// The HTTP tool wrapper: maps an AgentSpec `http_request` tool to both (a) a
// plain async function the workflow executor calls directly for the
// `execute_tool(name)` condition-branch syntax, and (b) a Mastra `Tool`
// definition, in case you want the model to call tools directly via
// Mastra's own tool-calling loop.

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Tool } from "./spec-types.js";

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
// author-controlled string with no character restriction, so it must never
// end up as a literal HTTP header value on a call that can reach a real
// third-party endpoint.
export interface ToolContext {
  readonly toolName: string;
}

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
 * call, and extracts the configured response field. A non-2xx response or
 * network error surfaces as a rejected promise with the tool's name in the
 * message, so a failed tool call halts the run and reports which step
 * failed rather than continuing silently.
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
