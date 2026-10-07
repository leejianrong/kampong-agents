import type { AgentSpec } from "./schema.js";

// Non-fatal findings about a spec that is valid but will not behave the way a reader might assume
// (KAN-1831, V11-X). Distinct from `SpecError`: a warning never blocks a run, an export or a canvas
// render. The CLI prints these to stderr and the canvas shows them in a banner, so a field the
// schema accepts but no engine path reads is never silently ignored.

export interface SpecWarning {
  code: "knowledge_base_not_executed" | "legacy_condition_syntax" | "legacy_placeholder_syntax";
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

  if (spec.version === "1.0") warnings.push(...legacySyntaxWarnings(spec));

  return warnings;
}

// A version "1.0" spec keeps working with the original reference syntax, and says so (KAN-1840,
// ADR-0027): `version: "1.1"` replaces both constructs below with expressions. Never an error.
const SINGLE_BRACE = /(?<!\{)\{[A-Za-z0-9_.]+\}(?!\})/;

function legacySyntaxWarnings(spec: AgentSpec): SpecWarning[] {
  const conditions: { step: string; path: (string | number)[] }[] = [];
  const placeholders: (string | number)[][] = [];
  spec.agent.workflow.forEach((step, i) => {
    if ("if" in step) conditions.push({ step: step.step, path: ["agent", "workflow", i, "if"] });
  });
  const scan = (value: unknown, path: (string | number)[]) => {
    if (typeof value === "string") {
      if (SINGLE_BRACE.test(value)) placeholders.push(path);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => scan(v, [...path, i]));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) scan(v, [...path, k]);
    }
  };
  scan(spec.agent.tools, ["agent", "tools"]);

  // One note per kind, listing where, so a spec with many conditions is not a wall of warnings.
  const warnings: SpecWarning[] = [];
  if (conditions.length > 0) {
    warnings.push({
      code: "legacy_condition_syntax",
      path: conditions[0]!.path,
      message:
        `${conditions.length === 1 ? "Condition" : "Conditions"} ${conditions.map((c) => `"${c.step}"`).join(", ")} ` +
        `use${conditions.length === 1 ? "s" : ""} the version 1.0 grammar (step.field <op> value). It keeps working; ` +
        `with version "1.1" a condition is an expression, which can combine tests and read arrays and nested fields.`,
    });
  }
  if (placeholders.length > 0) {
    warnings.push({
      code: "legacy_placeholder_syntax",
      path: placeholders[0]!,
      message:
        `${placeholders.map((p) => p.join(".")).join(", ")} ${placeholders.length === 1 ? "uses" : "use"} ` +
        `a {step.field} placeholder (version 1.0). It keeps working; version "1.1" writes references as {{ expression }}.`,
    });
  }
  return warnings;
}
