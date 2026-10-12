import { parseExpression, type ExpressionError } from "./expression.js";
import type { SchemaNode } from "./schema-node.js";
import type { AgentSpec, BodyStep, WorkflowStep } from "./schema.js";
import { ingressReadIssues, readIssues } from "./spec-expressions.js";

// What the canvas's expression input needs (KAN-1850): a live check that is the validator's own check, and
// completion for the names an expression may read at one point. Both are pure so they run in the browser and
// are tested without one. The check calls `parseExpression` and `readIssues`, the same two functions
// `validateSpecExpressions` calls when a spec loads, so the editor cannot accept what the validator refuses.

/** What an expression at one point of a spec may read. Build it with `expressionScopeFor`. */
export interface ExpressionScope {
  /** Declared var names; undefined when the spec has no `vars` block. */
  vars: string[] | undefined;
  /** Every step name the validator accepts here. */
  steps: string[];
  /** The steps that run before this point, in order: the ones worth suggesting. */
  earlier: string[];
  /** A foreach body's loop variable and the body steps before this one. */
  local: string[];
  /** Fields of `trigger`: a webhook's mapped names plus `headers` and `body`. */
  trigger: string[];
  /** Fields a step's output is known to have: an `output_schema`'s properties, a transform's `set` names. */
  stepFields: Record<string, string[]>;
  /** A webhook `when` / `map`: runs on arrival, reads only `trigger`. */
  ingress?: boolean;
}

export interface ExpressionDiagnostic {
  message: string;
  /** Character offset into the expression, when the problem has one (a syntax error). */
  position?: number;
  line?: number;
  column?: number;
}

function stepNamesOf(list: readonly (WorkflowStep | BodyStep)[]): string[] {
  return list.flatMap((s) => {
    if (!("branch" in s)) return [s.step];
    const b = s.branch;
    const arms =
      "if" in b
        ? [b.then, ...(b.else ? [b.else] : [])]
        : [...Object.values(b.cases), ...(b.default ? [b.default] : [])];
    return [s.step, ...arms.flatMap((arm) => stepNamesOf(arm))];
  });
}

function fieldsOf(step: WorkflowStep): string[] | undefined {
  if ("type" in step && step.type === "transform") return Object.keys(step.set);
  if ("output_schema" in step && step.output_schema !== undefined) {
    const schema: SchemaNode = step.output_schema;
    return Object.keys(schema.properties ?? {});
  }
  return undefined;
}

export interface ScopeOptions {
  /** Index in `agent.workflow` of the step being edited; omitted for a new step, which is added last. */
  stepIndex?: number;
  /** A foreach body's loop variable and earlier body steps. */
  local?: string[];
  /** Scope for a webhook `when` / `map`. */
  ingress?: boolean;
}

export function expressionScopeFor(spec: AgentSpec, options: ScopeOptions = {}): ExpressionScope {
  const workflow = spec.agent.workflow;
  const before = options.stepIndex === undefined ? workflow : workflow.slice(0, options.stepIndex);
  const stepFields: Record<string, string[]> = {};
  for (const step of before) {
    const fields = fieldsOf(step);
    if (fields !== undefined) stepFields[step.step] = fields;
  }
  const trigger = spec.agent.trigger;
  return {
    vars: spec.vars === undefined ? undefined : Object.keys(spec.vars),
    steps: [...new Set(stepNamesOf(workflow))],
    earlier: before.map((s) => s.step),
    local: options.local ?? [],
    trigger: [
      "headers",
      "body",
      ...(trigger?.type === "webhook" ? Object.keys(trigger.map ?? {}) : []),
    ],
    stepFields,
    ...(options.ingress && { ingress: true }),
  };
}

/** The problems with one expression: a syntax or rule error with where it is, or names nothing provides. */
export function checkExpression(source: string, scope: ExpressionScope): ExpressionDiagnostic[] {
  if (source.trim() === "") return [];
  const parsed = parseExpression(source);
  if (!parsed.ok) return parsed.errors.map(diagnostic);
  const messages = scope.ingress
    ? ingressReadIssues(parsed.ast)
    : readIssues(parsed.ast, { vars: scope.vars, steps: scope.steps, local: scope.local });
  return messages.map((message) => ({ message }));
}

function diagnostic(e: ExpressionError): ExpressionDiagnostic {
  return {
    message: e.message,
    ...(e.position !== undefined && { position: e.position }),
    ...(e.line !== undefined && { line: e.line }),
    ...(e.column !== undefined && { column: e.column }),
  };
}

export interface Completion {
  /** The path to insert, which replaces `from`..`to` of the text. */
  insert: string;
  /** What it is: "variable", "trigger field", "step output", "loop"... */
  detail: string;
}

export interface CompletionResult {
  from: number;
  to: number;
  items: Completion[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (name: string): string => (IDENT.test(name) ? name : `\`${name}\``);

/**
 * Names that may follow the path being typed at `cursor`: the roots at the start of a path (trigger, vars,
 * earlier steps, the loop variable), then the fields of whichever root was typed. Returns nothing inside a
 * `$function` name or where nothing is known.
 */
export function completeExpression(
  text: string,
  cursor: number,
  scope: ExpressionScope,
): CompletionResult {
  const head = text.slice(0, cursor);
  const token = /[A-Za-z0-9_.`$]*$/.exec(head)?.[0] ?? "";
  const from = cursor - token.length;
  if (token.startsWith("$")) return { from, to: cursor, items: [] };
  const parts = token.split(".").map((p) => p.replace(/`/g, ""));
  const partial = parts.pop() ?? "";
  const matches = (name: string) => name.toLowerCase().startsWith(partial.toLowerCase());
  const items: Completion[] = [];
  if (parts.length === 0) {
    const roots: Completion[] = scope.ingress
      ? [{ insert: "trigger", detail: "the request" }]
      : [
          { insert: "trigger", detail: "what started the run" },
          ...(scope.vars !== undefined ? [{ insert: "vars", detail: "variables" }] : []),
          ...scope.earlier.map((s) => ({ insert: ident(s), detail: "step output" })),
          ...scope.local.map((s) => ({ insert: ident(s), detail: "loop" })),
        ];
    items.push(...roots.filter((r) => matches(r.insert.replace(/`/g, ""))));
  } else if (parts.length === 1) {
    const root = parts[0]!;
    let names: string[] = [];
    let detail = "";
    if (root === "vars" && !scope.ingress) {
      names = scope.vars ?? [];
      detail = "variable";
    } else if (root === "trigger") {
      names = scope.trigger;
      detail = "trigger field";
    } else if (!scope.ingress) {
      names = scope.stepFields[root] ?? [];
      detail = "output field";
    }
    items.push(
      ...names.filter(matches).map((n) => ({ insert: `${ident(root)}.${ident(n)}`, detail })),
    );
  }
  return { from, to: cursor, items };
}
