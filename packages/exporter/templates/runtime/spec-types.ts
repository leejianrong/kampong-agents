// Plain TypeScript type definitions mirroring @kampong/spec's Zod-inferred
// AgentSpec shape (packages/spec/src/schema.ts as of this export), vendored
// here rather than imported from "@kampong/spec" -- see this repo's
// docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. This
// project never re-validates a spec at runtime (it's a fixed, already-
// validated literal baked into src/index.ts at export time), so only the
// *shape* needs to travel with the export -- not the Zod schema/validator
// itself, which also isn't a package this project could resolve standalone
// (no @kampong/* dependency, per this export's zero-lock-in guarantee).

export type ModelProvider = "anthropic" | "openai" | "ollama" | "openrouter";

export interface Model {
  provider: ModelProvider;
  name: string;
  api_key?: string;
  base_url?: string;
  timeout_ms?: number;
}

export interface KnowledgeItem {
  type: "pdf" | "url" | "text";
  source: string;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Tool {
  name: string;
  action: "http_request";
  method: HttpMethod;
  url: string;
  requires_approval?: boolean;
  extract?: string;
}

export type FallbackAction = "escalate_to_human";

export interface Guardrails {
  confidence_threshold?: number;
  fallback_action?: FallbackAction;
}

export type WorkflowStep =
  | {
      step: string;
      type: "condition";
      if: string;
      then: string;
      else: string;
    }
  | {
      step: string;
      action: string;
      inputs?: string[];
      query?: string;
      confidence_gate?: boolean;
    };

export interface AgentSpec {
  version: string;
  agent: {
    id: string;
    name: string;
    role: string;
    goal: string;
    model?: Model;
    knowledge_base?: KnowledgeItem[];
    tools?: Tool[];
    guardrails?: Guardrails;
    workflow: WorkflowStep[];
  };
}
