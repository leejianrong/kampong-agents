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

export interface HttpToolCallOptions {
  fetchImpl?: typeof fetch;
}

// Stamped on every outgoing call so the mock/record tool layer (V3,
// tool-fixtures.ts) can key a fixture on {tool name, method, substituted
// URL} without this file's caller (workflow.ts) changing at all -- the
// fixture layer wraps `fetchImpl` and reads this header back off; it
// doesn't need a modified `fetchImpl` signature to learn which tool a call
// belongs to. Harmless on a real live call (an extra header a real HTTP
// endpoint just ignores).
export const TOOL_NAME_HEADER = "x-kampong-tool-name";

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
  { fetchImpl = fetch }: HttpToolCallOptions = {},
): Promise<unknown> {
  const url = substitutePlaceholders(tool.url, params);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: tool.method,
      headers: { [TOOL_NAME_HEADER]: tool.name },
    });
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
