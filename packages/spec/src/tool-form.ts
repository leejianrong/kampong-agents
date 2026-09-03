import { toolSchema, type Tool } from "./schema.js";

// The "Add Tool" affordance (PLAN.md Affordances, Q12/R5): a structured
// form — name, HTTP method, URL with {placeholders}, response-extraction
// path — is the primary, zero-LLM-calls path for defining a tool.
// Natural-language-assisted drafting, if it ever ships, is a layer on top
// of this, not a replacement for it.

export interface ToolFormInput {
  name: string;
  method: string;
  url: string;
  requiresApproval?: boolean;
  extract?: string;
}

export interface ToolFormResult {
  success: boolean;
  tool?: Tool;
  errors?: string[];
}

export function buildToolFromForm(input: ToolFormInput): ToolFormResult {
  const candidate = {
    name: input.name,
    action: "http_request" as const,
    method: input.method,
    url: input.url,
    ...(input.requiresApproval !== undefined && { requires_approval: input.requiresApproval }),
    ...(input.extract !== undefined && { extract: input.extract }),
  };

  const result = toolSchema.safeParse(candidate);
  if (!result.success) {
    return { success: false, errors: result.error.issues.map((issue) => issue.message) };
  }
  return { success: true, tool: result.data };
}
