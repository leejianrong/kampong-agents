import { z } from "zod";
import { agentSpecSchema, SCHEMA_VERSION } from "./schema.js";

// Published JSON Schema artifact (PLAN.md Shape S7, ADR-0008): lets external
// editors and agentic coding tools (Cursor, Claude Code, Codex) validate and
// autocomplete AgentSpec YAML files via the yaml-language-server convention,
// with zero custom editor tooling on our side. Generated from the same Zod
// schema used for runtime validation, so the two can never drift apart.
//
// Zod v4 ships JSON Schema generation natively (`z.toJSONSchema`), so the
// `zod-to-json-schema` package (a v3-only shim -- its published types don't
// even accept a v4 schema instance) is no longer needed here. `target:
// "draft-07"` keeps the emitted `$schema` matching what this repo's Ajv
// version (and the checked-in `schemas/agent-spec.v1.0.schema.json`
// artifact) already expect; `reused: "inline"` matches the old
// `$refStrategy: "none"` behavior -- everything inlined, no `$ref`/`$defs`
// indirection for external tooling to resolve.
export function generateAgentSpecJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(agentSpecSchema, {
    target: "draft-07",
    reused: "inline",
  }) as Record<string, unknown>;
}

export function agentSpecJsonSchemaFilename(): string {
  return `agent-spec.v${SCHEMA_VERSION}.schema.json`;
}
