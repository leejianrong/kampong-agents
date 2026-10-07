import type { Document, LineCounter } from "yaml";
import {
  expressionPaths,
  parseExpression,
  templateExpressions,
  type ExpressionError,
} from "./expression.js";
import type { SpecError } from "./parse.js";
import type { AgentSpec } from "./schema.js";

// Checks every expression in a version "1.1" spec when it is parsed (KAN-1840): a condition's `if`, and
// each `{{ … }}` in a tool or a step. A bad expression is a validation error with the line it is on and
// where in the expression, and a name that nothing provides (a typo in `vars.threshhold`, a step that does
// not exist) is an error too: such a reference does not fail at run time, it evaluates to nothing, and a
// condition on nothing is silently false (ADR-0027, spike result).

const ROOTS = ["trigger", "input", "vars"] as const;

function lineColumn(doc: Document, lineCounter: LineCounter, path: (string | number)[]) {
  try {
    const node = doc.getIn(path, true) as { range?: [number, number, number] } | null;
    if (node && typeof node === "object" && node.range) {
      const pos = lineCounter.linePos(node.range[0]);
      return { line: pos.line, column: pos.col };
    }
  } catch {
    // The path does not resolve to a node; the error carries no position.
  }
  return {};
}

export function validateSpecExpressions(
  spec: AgentSpec,
  doc: Document,
  lineCounter: LineCounter,
): SpecError[] {
  if (spec.version !== "1.1") return [];
  const errors: SpecError[] = [];
  const stepNames = spec.agent.workflow.map((s) => s.step);
  const varNames = Object.keys(spec.vars ?? {});

  const report = (path: (string | number)[], message: string) =>
    errors.push({ path, message, ...lineColumn(doc, lineCounter, path) });
  const reportExpression = (path: (string | number)[], where: string, e: ExpressionError) =>
    report(
      path,
      `${where}: ${e.message}${e.position !== undefined ? ` (character ${e.position}${e.line && e.line > 1 ? `, line ${e.line}` : ""})` : ""}`,
    );

  const check = (path: (string | number)[], source: string, where: string) => {
    const parsed = parseExpression(source);
    if (!parsed.ok) {
      for (const e of parsed.errors) reportExpression(path, where, e);
      return;
    }
    for (const names of expressionPaths(parsed.ast)) {
      const [root, second] = names;
      if (root === undefined) continue;
      if (root === "vars") {
        if (second !== undefined && !varNames.includes(second)) {
          report(
            path,
            `${where}: vars.${second} is not declared in vars` +
              (varNames.length > 0
                ? ` (declared: ${varNames.join(", ")})`
                : " (there is no vars block)"),
          );
        }
      } else if (!(ROOTS as readonly string[]).includes(root) && !stepNames.includes(root)) {
        report(
          path,
          `${where}: "${root}" is not something an expression can read: use trigger, input, vars, ` +
            `or the name of a step (${stepNames.join(", ")})`,
        );
      }
    }
  };

  const scan = (value: unknown, path: (string | number)[]) => {
    if (typeof value === "string") {
      for (const { expression } of templateExpressions(value)) {
        check(path, expression, `{{ ${expression.trim()} }}`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => scan(v, [...path, i]));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) scan(v, [...path, k]);
    }
  };

  spec.agent.workflow.forEach((step, i) => {
    if ("if" in step) check(["agent", "workflow", i, "if"], step.if, `condition "${step.step}"`);
    scan(step, ["agent", "workflow", i]);
  });
  scan(spec.agent.tools, ["agent", "tools"]);
  return errors;
}
