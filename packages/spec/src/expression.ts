import jsonata from "jsonata";

// Expressions (KAN-1840, ADR-0027). One language, JSONata, wherever a spec computes a value. This file is
// the parse-time half of the contract the spike (KAN-1839) set out: it decides whether an expression is
// acceptable *before* anything evaluates it, with errors that say where. Evaluation (and the run-time
// guards: timeout, stack, size limits) belongs to the engine.

/** Longer than this is refused: the parser overflows the stack on deeply nested source, with no position. */
export const MAX_EXPRESSION_LENGTH = 4000;

/**
 * Built-ins that are not a pure function of the input: three read the clock or a random source, and
 * `$eval` runs a string as code. They are found in the syntax tree, so aliasing one (`$f := $now`) or passing
 * it as a value (`$map(a, $random)`) is caught too.
 */
export const DENIED_FUNCTIONS = ["now", "millis", "random", "shuffle", "eval"] as const;

export interface ExpressionError {
  code: string;
  message: string;
  /** Character offset into the expression, when the error has one. */
  position?: number;
  /** 1-based, from `position`. */
  line?: number;
  column?: number;
}

/** A syntax tree node as JSONata exposes it; only the parts this file reads. */
export interface ExpressionNode {
  type: string;
  value?: unknown;
  position?: number;
  [key: string]: unknown;
}

export type ParsedExpression =
  { ok: true; ast: ExpressionNode } | { ok: false; errors: ExpressionError[] };

function located(source: string, error: ExpressionError): ExpressionError {
  if (error.position === undefined) return error;
  const before = source.slice(0, error.position);
  return {
    ...error,
    line: before.split("\n").length,
    column: error.position - before.lastIndexOf("\n"),
  };
}

/** JSONata throws plain objects, not Errors, with `{ code, message, position }`. */
function normalise(source: string, thrown: unknown): ExpressionError {
  const e = (thrown ?? {}) as { code?: unknown; message?: unknown; position?: unknown };
  return located(source, {
    code: typeof e.code === "string" ? e.code : "E0000",
    message: typeof e.message === "string" ? e.message : String(thrown),
    ...(typeof e.position === "number" && { position: e.position }),
  });
}

function walk(node: unknown, visit: (n: ExpressionNode) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (!node || typeof node !== "object") return;
  const n = node as ExpressionNode;
  if (typeof n.type === "string") visit(n);
  for (const value of Object.values(n)) {
    if (value && typeof value === "object") walk(value, visit);
  }
}

/**
 * Parses an expression and applies the rules a spec must meet: not too long, no non-deterministic or
 * dynamic built-in, no regular expression literal (a backtracking regex cannot be interrupted, so they stay
 * out until a safe engine exists). Never throws.
 */
export function parseExpression(source: string): ParsedExpression {
  if (source.trim() === "") {
    return { ok: false, errors: [{ code: "E0001", message: "The expression is empty" }] };
  }
  if (source.length > MAX_EXPRESSION_LENGTH) {
    return {
      ok: false,
      errors: [
        {
          code: "E0002",
          message: `The expression is ${source.length} characters long; the limit is ${MAX_EXPRESSION_LENGTH}`,
        },
      ],
    };
  }
  let ast: ExpressionNode;
  try {
    ast = jsonata(source).ast() as ExpressionNode;
  } catch (thrown) {
    return { ok: false, errors: [normalise(source, thrown)] };
  }
  const errors: ExpressionError[] = [];
  walk(ast, (n) => {
    if (n.type === "variable" && (DENIED_FUNCTIONS as readonly unknown[]).includes(n.value)) {
      errors.push(
        located(source, {
          code: "E0003",
          message: `$${String(n.value)} is not available: its result is not a function of the input alone`,
          ...(typeof n.position === "number" && { position: n.position }),
        }),
      );
    }
    if (n.type === "regex") {
      errors.push(
        located(source, {
          code: "E0004",
          message: "Regular expressions are not available in expressions",
          ...(typeof n.position === "number" && { position: n.position }),
        }),
      );
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, ast };
}

/** Whether an expression refers to the built-in `$name` (calls it or passes it as a value). */
export function expressionUses(ast: ExpressionNode, name: string): boolean {
  let found = false;
  walk(ast, (n) => {
    if (n.type === "variable" && n.value === name) found = true;
  });
  return found;
}

/**
 * What an expression reads from the data it is given: the leading names of each path that starts at the
 * root (`["vars", "threshold"]`, `["trigger", "alerts"]`, `["review", "summary"]`). Names inside a filter, a
 * lambda or a `.(…)` step are relative to their own context, not reads of the root, and are left out.
 */
export function expressionPaths(ast: ExpressionNode): string[][] {
  const paths: string[][] = [];
  const visit = (node: unknown, relative: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, relative));
      return;
    }
    if (!node || typeof node !== "object") return;
    const n = node as ExpressionNode;
    if (n.type === "path") {
      const steps = (n.steps as ExpressionNode[]) ?? [];
      if (!relative && steps[0]?.type === "name") {
        const names: string[] = [];
        for (const step of steps) {
          if (step.type !== "name" || typeof step.value !== "string") break;
          names.push(step.value);
        }
        paths.push(names);
      }
      steps.forEach((step, i) => {
        // Only the first step's own predicates are about this path's items; both are relative contexts.
        visit(step, relative || i > 0);
      });
      return;
    }
    if (n.type === "lambda") {
      visit(n.body, true);
      return;
    }
    if (n.type === "filter") {
      visit(n.expr, true);
      return;
    }
    if (n.type === "transform") {
      // `| pattern | update |` applies to each match of the pattern in the value it is given, so names
      // inside either are relative to that value, not reads of the root.
      visit(n.pattern, true);
      visit(n.update, true);
      visit(n.delete, true);
      return;
    }
    for (const [key, value] of Object.entries(n)) {
      if (key === "position" || key === "type") continue;
      if (value && typeof value === "object") visit(value, relative);
    }
  };
  visit(ast, false);
  return paths;
}

/**
 * The `{{ … }}` spans in a template string, with where each expression starts inside the string. The end is
 * the first `}}` that is not inside a string literal or a brace opened by the expression, so an object
 * constructor (`{{ {"a": {"b": 1}}.a }}`) and a string holding `}}` are read whole. An opening `{{` with no
 * end is plain text.
 */
export function templateExpressions(text: string): { expression: string; offset: number }[] {
  const out: { expression: string; offset: number }[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{{", i);
    if (start < 0) break;
    let depth = 0;
    let quote: string | undefined;
    let end = -1;
    for (let j = start + 2; j < text.length; j++) {
      const c = text[j]!;
      if (quote) {
        if (c === "\\" && quote !== "`") j++;
        else if (c === quote) quote = undefined;
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        if (depth === 0 && text[j + 1] === "}") {
          end = j;
          break;
        }
        if (depth > 0) depth--;
      }
    }
    if (end < 0) break;
    out.push({ expression: text.slice(start + 2, end), offset: start + 2 });
    i = end + 2;
  }
  return out;
}
