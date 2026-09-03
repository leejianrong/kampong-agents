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
// V2 shipped anthropic/openai; "ollama" (V3, SLICES.md KAN-1112) is the local
// adapter -- it needs no cloud API key and typically runs on
// http://localhost:11434, which is why `api_key` below is optional at the
// schema level rather than gaining an ollama-shaped exception to the regex.
export const modelProviderSchema = z.enum(["anthropic", "openai", "ollama"]);

export const modelSchema = z
  .object({
    provider: modelProviderSchema,
    name: z.string().min(1),
    // Optional at the field level so a local-only ("ollama") spec never has
    // to invent a placeholder env var it doesn't need; the `.superRefine`
    // below is what actually enforces this as required for the cloud
    // providers ("anthropic"/"openai") so a spec missing it fails schema
    // validation (exit 1) rather than surfacing later as a raw `Error` out
    // of packages/engine's model-resolution path (exit 2).
    api_key: envVarPlaceholderSchema.optional(),
    // Only meaningful for "ollama" today (points at a non-default local
    // server, e.g. a remote/tunneled Ollama host); harmless no-op for the
    // cloud providers, which always call their own fixed API host.
    base_url: z.string().url().optional(),
  })
  .superRefine((model, ctx) => {
    if (model.provider !== "ollama" && model.api_key === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `api_key is required for provider "${model.provider}" (only "ollama" may omit it)`,
        path: ["api_key"],
      });
    }
  });

// KNOWN LIMITATION (finding #8, ADR-0008): `zod-to-json-schema` (see
// json-schema.ts) does not translate a `.superRefine` cross-field
// constraint into the emitted JSON Schema at all -- the published
// `agent-spec.v1.0.schema.json` artifact still shows `model.api_key` as
// unconditionally optional, so an external editor (Cursor, yaml-language-
// server, etc.) validating a cloud-provider spec missing `api_key` will NOT
// flag it, even though `parseSpec()` (this package's own Zod-backed
// validator, which every real `kampong` code path actually runs through)
// does. Only this file's `agentSpecSchema.safeParse` enforces the "api_key
// required unless ollama" rule; the JSON Schema is a (deliberately)
// looser approximation for editor tooling. Revisit if this gap proves
// costly enough to warrant a hand-authored `oneOf`/`if`/`then` addition to
// the generated artifact, or a switch to a JSON-Schema generator that
// supports refinements.

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
