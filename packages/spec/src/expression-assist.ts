import { ingressProblem, nameProblem } from "./expression-names.js";
import { expressionPaths, parseExpression } from "./expression.js";
import type { AgentSpec, WorkflowStep } from "./schema.js";

// What the canvas's expression field needs to help someone write a JSONata expression (KAM-160, a slice of
// KAM-110): the names in scope at a field, a check that says what the spec loader would say (the same parser and
// the same name rule, so the canvas and a save cannot disagree), and completions for the path being typed. All of
// it is pure, so it is tested here and the field component only draws it.

export interface ScopeStep {
  name: string;
  /** What a step's output is known to hold: an output_schema's properties, or a transform's `set` names. */
  fields: string[];
}

export interface ExpressionScope {
  vars: { name: string; detail: string }[];
  /** Every step an expression may name: what the loader accepts. */
  steps: ScopeStep[];
  /** The steps that have run by the field being edited: what completion offers. Defaults to `steps`. */
  ready?: ScopeStep[];
  /** A foreach body's loop variable and earlier body steps. */
  local?: ScopeStep[];
  /** Fields a webhook's `map` puts on `trigger`, beyond `headers` and `body`. */
  trigger: string[];
  /**
   * Where the expression runs, when that is not a workflow step. `ingress` is a webhook's `when`/`map`, which run
   * as the request arrives and read only `trigger`. `item` is a poll's `items`/`id`, which read the op's result
   * and so have no names of the spec's to check or offer.
   */
  kind?: "ingress" | "item";
}

export interface ExpressionDiagnostic {
  message: string;
  /** Character offset into the source, when the problem has one. */
  position?: number;
}

export interface Completion {
  label: string;
  detail?: string;
}

function fieldsOf(step: WorkflowStep): string[] {
  if ("type" in step && step.type === "transform") return Object.keys(step.set);
  if ("output_schema" in step && step.output_schema) {
    const schema = step.output_schema as { properties?: Record<string, unknown> };
    return Object.keys(schema.properties ?? {});
  }
  return [];
}

/** Every step in the workflow, in order, with the steps inside a branch's arms after their branch. */
function flatten(list: readonly WorkflowStep[]): WorkflowStep[] {
  return list.flatMap((step) => {
    if (!("branch" in step)) return [step];
    const b = step.branch;
    const arms = "if" in b ? [b.then, b.else ?? []] : [...Object.values(b.cases), b.default ?? []];
    return [step, ...flatten(arms.flat() as WorkflowStep[])];
  });
}

/**
 * The scope at a field. `before` is the name of the step being edited (or about to be added at the end, when
 * omitted): completion offers only the steps ahead of it, since a later step has no output yet, while the check
 * accepts any step name, as the loader does.
 */
export function expressionScopeFor(
  spec: AgentSpec,
  options: { before?: string; local?: ScopeStep[] } = {},
): ExpressionScope {
  const steps = flatten(spec.agent.workflow).map((s) => ({ name: s.step, fields: fieldsOf(s) }));
  const at = options.before === undefined ? -1 : steps.findIndex((s) => s.name === options.before);
  const trigger = spec.agent.trigger;
  return {
    vars: Object.entries(spec.vars ?? {}).map(([name, v]) => ({
      name,
      detail: v.type === "list" ? `list of ${v.items ?? "string"}` : v.type,
    })),
    steps,
    ready: at < 0 ? steps : steps.slice(0, at),
    ...(options.local && { local: options.local }),
    trigger: trigger?.type === "webhook" ? Object.keys(trigger.map ?? {}) : [],
  };
}

/** What is wrong with `source`, as the spec loader would say it. An empty field has no diagnostics. */
export function diagnoseExpression(source: string, scope: ExpressionScope): ExpressionDiagnostic[] {
  if (source.trim() === "") return [];
  const parsed = parseExpression(source);
  if (!parsed.ok) {
    return parsed.errors.map((e) => ({
      message: e.message,
      ...(e.position !== undefined && { position: e.position }),
    }));
  }
  if (scope.kind === "item") return [];
  if (scope.kind === "ingress") {
    const seen = new Set<string>();
    const out: ExpressionDiagnostic[] = [];
    for (const [root] of expressionPaths(parsed.ast)) {
      const message = ingressProblem(root, "this expression");
      if (message !== undefined && !seen.has(message)) {
        seen.add(message);
        out.push({ message });
      }
    }
    return out;
  }
  const names = {
    varNames: scope.vars.map((v) => v.name),
    stepNames: scope.steps.map((s) => s.name),
    local: (scope.local ?? []).map((s) => s.name),
  };
  const seen = new Set<string>();
  const out: ExpressionDiagnostic[] = [];
  for (const path of expressionPaths(parsed.ast)) {
    const message = nameProblem(path, names);
    if (message !== undefined && !seen.has(message)) {
      seen.add(message);
      out.push({ message });
    }
  }
  return out;
}

const TOKEN = /[A-Za-z0-9_.]*$/;

function insideString(head: string): boolean {
  let quote: string | undefined;
  for (let i = 0; i < head.length; i++) {
    const c = head[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
  }
  return quote !== undefined;
}

/**
 * Completions for the path ending at `cursor`: the roots (trigger, input, vars, the steps that have run), then
 * `vars.` names, `trigger.` fields, and a step's known output fields. `from` is where the typed part starts, so
 * accepting one replaces it. Nothing inside a string, after `$` (a built-in function) or after a lone `.`.
 * With nothing typed it offers the roots only when asked (`explicit`, e.g. Ctrl+Space).
 */
export function completeExpression(
  source: string,
  cursor: number,
  scope: ExpressionScope,
  options: { explicit?: boolean } = {},
): { from: number; options: Completion[] } {
  const none = { from: cursor, options: [] };
  if (scope.kind === "item") return none;
  const head = source.slice(0, cursor);
  if (insideString(head)) return none;
  const token = TOKEN.exec(head)![0];
  const start = cursor - token.length;
  if (
    head[start - 1] === "$" ||
    head[start - 1] === "`" ||
    /^\d/.test(token) ||
    token.startsWith(".")
  ) {
    return none;
  }
  const parts = token.split(".");
  const partial = parts.pop()!;
  const from = cursor - partial.length;
  if (parts.length === 0 && partial === "" && !options.explicit) return none;

  let candidates: Completion[] = [];
  if (parts.length === 0 && scope.kind === "ingress") {
    candidates = [{ label: "trigger", detail: "the request" }];
  } else if (parts.length === 0) {
    candidates = [
      ...(scope.local ?? []).map((s) => ({ label: s.name, detail: "loop" })),
      { label: "trigger", detail: "what started the run" },
      { label: "input", detail: "the run's input text" },
      { label: "vars", detail: "the spec's vars" },
      ...(scope.ready ?? scope.steps).map((s) => ({ label: s.name, detail: "step output" })),
    ];
  } else if (parts.length === 1) {
    const [root] = parts as [string];
    if (root === "vars") {
      candidates = scope.vars.map((v) => ({ label: v.name, detail: v.detail }));
    } else if (root === "trigger") {
      candidates = [
        { label: "headers", detail: "request headers" },
        { label: "body", detail: "the request body" },
        ...scope.trigger.map((label) => ({ label, detail: "from the trigger's map" })),
      ];
    } else {
      const step = [...(scope.local ?? []), ...(scope.ready ?? scope.steps)].find(
        (s) => s.name === root,
      );
      candidates = (step?.fields ?? []).map((label) => ({ label, detail: `${root} output` }));
    }
  }
  const lower = partial.toLowerCase();
  return {
    from,
    options: candidates.filter(
      (c) => c.label.toLowerCase().startsWith(lower) && c.label !== partial,
    ),
  };
}
