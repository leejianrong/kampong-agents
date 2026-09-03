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

// Constrained to what packages/engine actually implements (checked directly
// -- workflow.ts only branches on this literal) rather than an open string,
// so an unsupported value is a spec-validation error, not a runtime failure
// mid-run.
export const fallbackActionSchema = z.enum(["escalate_to_human"]);

export const guardrailsSchema = z.object({
  confidence_threshold: z.number().min(0).max(1).optional(),
  fallback_action: fallbackActionSchema.optional(),
});

// BYOK (SLICES.md V2, KAN-1106, Q14): a secret is never a literal in the
// spec -- only a `${ENV_VAR}` placeholder resolved from the environment at
// run time (packages/engine). This regex is the schema-level guarantee that
// a spec can never carry a real key value, not just a convention.
export const envVarPlaceholderSchema = z
  .string()
  .regex(
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/,
    "must reference an environment variable as ${ENV_VAR}, never a literal secret",
  );

// Kept to provider + model name (ADR-0004): generic enough that a future
// gateway (roadmap V5) slots in behind resolution, not into the spec shape.
// V2 ships anthropic/openai; the local Ollama adapter (V3) adds a provider
// value here without changing this schema.
export const modelProviderSchema = z.enum(["anthropic", "openai"]);

export const modelSchema = z.object({
  provider: modelProviderSchema,
  name: z.string().min(1),
  api_key: envVarPlaceholderSchema,
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
    // Marks this step as one where the model's output confidence matters
    // (KAN-1105 -- see docs/adr/0009 for why this lives on the step rather
    // than being inferred automatically): the engine asks the model for a
    // structured { result, confidence } response and checks it against
    // `guardrails.confidence_threshold` after the step runs.
    confidence_gate: z.boolean().optional(),
  }),
]);

export const agentSpecSchema = z.object({
  version: z.string().min(1),
  agent: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    role: z.string().min(1),
    goal: z.string().min(1),
    // Optional so every V1 spec (authored before BYOK existed) keeps
    // validating unchanged; the execution engine (not the schema) is what
    // requires it to be present before a real run can start.
    model: modelSchema.optional(),
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
export type FallbackAction = z.infer<typeof fallbackActionSchema>;
export type Model = z.infer<typeof modelSchema>;
export type ModelProvider = z.infer<typeof modelProviderSchema>;
