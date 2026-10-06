import { z } from "zod";
import { componentManifestSchema } from "./component.js";
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

// The component manifest (ADR-0029) is published the same way, so an editor or agentic tool authoring
// a manifest gets validation and autocomplete. The cross-field lint (undeclared references, egress
// coverage) is code, not schema, so `kampong doctor` and the loader remain the full check.
export const COMPONENT_MANIFEST_SCHEMA_VERSION = "1.0";

export function generateComponentManifestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(componentManifestSchema, {
    target: "draft-07",
    reused: "inline",
  }) as Record<string, unknown>;
}

export function componentManifestJsonSchemaFilename(): string {
  return `component-manifest.v${COMPONENT_MANIFEST_SCHEMA_VERSION}.schema.json`;
}
