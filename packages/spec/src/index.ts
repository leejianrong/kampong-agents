// AgentSpec schema + validator (PLAN.md Shape S1, ADR-0002: YAML is the
// single lossless source of truth). Parsed via the `yaml` package rather
// than `js-yaml` because its Document API preserves comments and formatting
// across a round trip (ADR-0007) — load-bearing for R1's "zero data loss"
// promise.

export const PACKAGE_NAME = "@kampong/spec";

export * from "./schema.js";
export * from "./parse.js";
export * from "./mutate.js";
export * from "./layout.js";
export * from "./graph.js";
export * from "./tool-form.js";
export * from "./workflow-form.js";
export * from "./json-schema.js";
export * from "./pragma.js";
export * from "./repository.js";
