import type { AgentSpec } from "./schema.js";

// Non-fatal findings about a spec that is valid but will not behave the way a reader might assume
// (KAN-1831, V11-X). Distinct from `SpecError`: a warning never blocks a run, an export or a canvas
// render. The CLI prints these to stderr and the canvas shows them in a banner, so a field the
// schema accepts but no engine path reads is never silently ignored.

export interface SpecWarning {
  code: "knowledge_base_not_executed";
  path: (string | number)[];
  message: string;
}

export function specWarnings(spec: AgentSpec): SpecWarning[] {
  const warnings: SpecWarning[] = [];

  if ((spec.agent.knowledge_base?.length ?? 0) > 0) {
    warnings.push({
      code: "knowledge_base_not_executed",
      path: ["agent", "knowledge_base"],
      message:
        "agent.knowledge_base is declared but not yet executed: its sources are not retrieved or " +
        "injected into any step, so it documents intent only.",
    });
  }

  return warnings;
}
