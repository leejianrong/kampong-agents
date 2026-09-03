import { z } from "zod";

// Trimmed single-agent AgentSpec (ADR-0001: no multi-agent/sub_agents field
// in v1, but the shape below leaves room to add one later without breaking
// existing specs). Field shape follows the example already sketched in
// ideation.md §4.2.

export const SCHEMA_VERSION = "1.0";

export const knowledgeItemSchema = z.object({
  type: z.enum(["pdf", "url", "text"]),
  source: z.string().min(1),
});

export const httpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const toolSchema = z.object({
  name: z.string().min(1),
  action: z.literal("http_request"),
  method: httpMethodSchema,
  url: z.string().min(1),
  requires_approval: z.boolean().optional(),
  extract: z.string().optional(),
});

export const guardrailsSchema = z.object({
  confidence_threshold: z.number().min(0).max(1).optional(),
  fallback_action: z.string().optional(),
});

export const workflowStepSchema = z.union([
  z.object({
    step: z.string().min(1),
    type: z.literal("condition"),
    if: z.string().min(1),
    then: z.string().min(1),
    else: z.string().min(1),
  }),
  z.object({
    step: z.string().min(1),
    action: z.string().min(1),
    inputs: z.array(z.string()).optional(),
    query: z.string().optional(),
  }),
]);

export const agentSpecSchema = z.object({
  version: z.string().min(1),
  agent: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    role: z.string().min(1),
    goal: z.string().min(1),
    knowledge_base: z.array(knowledgeItemSchema).optional(),
    tools: z.array(toolSchema).optional(),
    guardrails: guardrailsSchema.optional(),
    workflow: z.array(workflowStepSchema).min(1),
  }),
});

export type AgentSpec = z.infer<typeof agentSpecSchema>;
export type Tool = z.infer<typeof toolSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type Guardrails = z.infer<typeof guardrailsSchema>;
