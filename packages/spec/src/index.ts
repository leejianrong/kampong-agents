// AgentSpec schema + validator (PLAN.md Shape S1, ADR-0002: YAML is the
// single lossless source of truth). Parsed via the `yaml` package rather
// than `js-yaml` because its Document API preserves comments and formatting
// across a round trip (ADR-0007) — load-bearing for R1's "zero data loss"
// promise. The real schema/validator/JSON Schema artifact (S7) land with
// SLICES.md V1 — this file is scaffolding only, to prove the build/lint/
// test pipeline with the chosen library wired in.

import { parseDocument } from "yaml";

export const PACKAGE_NAME = "@kampong/spec";

export function parseYamlDocument(source: string) {
  return parseDocument(source);
}
