import { zodToJsonSchema } from "zod-to-json-schema";
import { agentSpecSchema, SCHEMA_VERSION } from "./schema.js";

// Published JSON Schema artifact (PLAN.md Shape S7, ADR-0008): lets external
// editors and agentic coding tools (Cursor, Claude Code, Codex) validate and
// autocomplete AgentSpec YAML files via the yaml-language-server convention,
// with zero custom editor tooling on our side. Generated from the same Zod
// schema used for runtime validation, so the two can never drift apart.

export function generateAgentSpecJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(agentSpecSchema, {
    name: "AgentSpec",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

export function agentSpecJsonSchemaFilename(): string {
  return `agent-spec.v${SCHEMA_VERSION}.schema.json`;
}
