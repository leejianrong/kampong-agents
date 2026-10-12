import { isMap, isScalar, type Document, type LineCounter } from "yaml";
import {
  expressionPaths,
  parseExpression,
  type ExpressionNode,
  templateExpressions,
  type ExpressionError,
} from "./expression.js";
import type { SpecError } from "./parse.js";
import type { AgentSpec, BodyStep, BranchStep, WorkflowStep } from "./schema.js";

// Checks every expression in a version "1.1" spec when it is parsed (KAN-1840): a condition's `if`, and
// each `{{ … }}` in a tool or a step. A bad expression is a validation error with the line it is on and
// where in the expression, and a name that nothing provides (a typo in `vars.threshhold`, a step that does
// not exist) is an error too: such a reference does not fail at run time, it evaluates to nothing, and a
// condition on nothing is silently false (ADR-0027, spike result).

const ROOTS = ["trigger", "input", "vars"] as const;

/** What an expression may read at one point: see `readIssues`. */
export interface ReadScope {
  /** The declared var names, or undefined when the spec has no `vars` block. */
  vars: readonly string[] | undefined;
  /** Every step name in the workflow (a branch arm's included). */
  steps: readonly string[];
  /** A foreach body adds the loop variable and the body steps that ran before. */
  local: readonly string[];
  /** Maps a step in a sibling branch arm to its branch, which an expression may not read. */
  hidden?: ReadonlyMap<string, string>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What is wrong with the names a parsed expression reads, as messages with no location prefix. The one
 * implementation behind both the spec validator and the canvas's live expression check, so the editor
 * never accepts what the validator refuses.
 */
export function readIssues(ast: ExpressionNode, scope: ReadScope): string[] {
  const out: string[] = [];
  const varNames = scope.vars ?? [];
  const oddStepNames = scope.steps.filter((n) => !IDENT.test(n));
  for (const names of expressionPaths(ast)) {
    const [root, second] = names;
    if (root === undefined) continue;
    const sibling = scope.hidden?.get(root);
    if (sibling !== undefined) {
      out.push(
        `"${root}" is a step in another arm of branch "${sibling}", which may not run: ` +
          `its output is not available here (read it after the branch, where it is present only if that arm ran)`,
      );
    } else if (root === "vars") {
      if (second !== undefined && !varNames.includes(second)) {
        out.push(
          `vars.${second} is not declared in vars` +
            (varNames.length > 0
              ? ` (declared: ${varNames.join(", ")})`
              : " (there is no vars block)"),
        );
      }
    } else if (
      !(ROOTS as readonly string[]).includes(root) &&
      !scope.steps.includes(root) &&
      !scope.local.includes(root)
    ) {
      out.push(
        `"${root}" is not something an expression can read: use trigger, input, vars, ` +
          `or the name of a step (${[...scope.steps, ...scope.local].join(", ")})` +
          (oddStepNames.length > 0
            ? `. A step name that is not a plain identifier (${oddStepNames.join(", ")}) must be written in backticks: \`${oddStepNames[0]}\`.field`
            : ""),
      );
    }
  }
  return out;
}

/** What is wrong with a webhook `when` / `map` expression: it runs on arrival and reads only `trigger`. */
export function ingressReadIssues(ast: ExpressionNode): string[] {
  return expressionPaths(ast).flatMap(([root]) =>
    root !== undefined && root !== "trigger"
      ? [
          `"${root}" is not available when a request arrives: it can read only trigger (trigger.headers, trigger.body, and the body's fields)`,
        ]
      : [],
  );
}

// What an expression in one step may read besides the root names and the workflow's steps: `local` is what a
// foreach body adds (the loop variable and the body steps that ran before), and `hidden` maps the name of a step
// in a sibling arm to its branch, which an expression may not read.
interface View {
  local: readonly string[];
  hidden: ReadonlyMap<string, string>;
}
const NO_VIEW: View = { local: [], hidden: new Map() };

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
  // Every step name in the workflow, the steps inside branch arms included (a foreach body's names are local to
  // the loop and are added to a `view` as the body is walked).
  const armsOf = (step: BranchStep): { key: (string | number)[]; list: WorkflowStep[] }[] => {
    const b = step.branch;
    if ("if" in b) {
      return [
        { key: ["branch", "then"], list: b.then },
        ...(b.else ? [{ key: ["branch", "else"], list: b.else }] : []),
      ];
    }
    return [
      ...Object.entries(b.cases).map(([k, list]) => ({
        key: ["branch", "cases", k] as (string | number)[],
        list,
      })),
      ...(b.default ? [{ key: ["branch", "default"], list: b.default }] : []),
    ];
  };
  const namesIn = (list: readonly (WorkflowStep | BodyStep)[]): string[] =>
    list.flatMap((s) => [
      s.step,
      ...("branch" in s ? armsOf(s).flatMap((a) => namesIn(a.list)) : []),
    ]);
  const stepNames = [...new Set(namesIn(spec.agent.workflow))];
  const varNames = Object.keys(spec.vars ?? {});

  const report = (path: (string | number)[], message: string) =>
    errors.push({ path, message, ...lineColumn(doc, lineCounter, path) });
  const reportExpression = (path: (string | number)[], where: string, e: ExpressionError) =>
    report(
      path,
      `${where}: ${e.message}${e.position !== undefined ? ` (character ${e.position}${e.line && e.line > 1 ? `, line ${e.line}` : ""})` : ""}`,
    );

  const check = (
    path: (string | number)[],
    source: string,
    where: string,
    lineInField?: number,
    view: View = NO_VIEW,
  ) => {
    const local = view.local;
    const parsed = parseExpression(source);
    // In a multi-line field the error is placed at the start of the field, so say which line of it.
    const here = lineInField && lineInField > 1 ? ` [line ${lineInField} of the field]` : "";
    if (!parsed.ok) {
      for (const e of parsed.errors) reportExpression(path, `${where}${here}`, e);
      return;
    }
    for (const message of readIssues(parsed.ast, {
      vars: spec.vars === undefined ? undefined : varNames,
      steps: stepNames,
      local,
      hidden: view.hidden,
    })) {
      report(path, `${where}${here}: ${message}`);
    }
  };

  const scan = (value: unknown, path: (string | number)[], local: View = NO_VIEW) => {
    if (typeof value === "string") {
      for (const { expression, offset } of templateExpressions(value)) {
        const lineInField = value.slice(0, offset).split("\n").length;
        check(path, expression, `{{ ${expression.trim()} }}`, lineInField, local);
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => scan(v, [...path, i], local));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) scan(v, [...path, k], local);
    }
  };

  // A YAML mapping may hold `1` and `"1"` as different keys that the spec reads as the same case (the value of a
  // switch is compared as text), so duplicates are looked for in the document, where both are still visible.
  // (Two identical keys are already a syntax error from the YAML parser.)
  const reportDuplicateCases = (path: (string | number)[]) => {
    const node = doc.getIn(path, true);
    if (!isMap(node)) return;
    const seen = new Set<string>();
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      if (seen.has(key)) {
        const range = isScalar(pair.key) ? pair.key.range : null;
        const pos = range ? lineCounter.linePos(range[0]) : undefined;
        errors.push({
          path: [...path, key],
          message: `duplicate case "${key}": a switch compares its value as text, so each case value may appear once`,
          ...(pos && { line: pos.line, column: pos.col }),
        });
      }
      seen.add(key);
    }
  };

  // One leaf step's expressions.
  const checkLeaf = (step: BodyStep | WorkflowStep, at: (string | number)[], view: View) => {
    if ("foreach" in step || "branch" in step) return;
    if ("stop" in step) {
      if (step.stop.reason !== undefined) scan(step.stop.reason, [...at, "stop", "reason"], view);
      return;
    }
    if ("if" in step) check([...at, "if"], step.if, `condition "${step.step}"`, undefined, view);
    // The data steps (KAN-1860) hold whole expressions, not `{{ }}` text, so they are checked as they are.
    if ("type" in step && step.type === "transform") {
      for (const [name, source] of Object.entries(step.set)) {
        check(
          [...at, "set", name],
          source,
          `transform "${step.step}" set.${name}`,
          undefined,
          view,
        );
      }
      return;
    } else if ("type" in step && step.type === "validate") {
      check([...at, "assert"], step.assert, `validate "${step.step}" assert`, undefined, view);
      if (step.message !== undefined) scan(step.message, [...at, "message"], view);
      return;
    } else if ("type" in step && step.type === "dedupe") {
      check(
        [...at, "once", "key"],
        step.once.key,
        `dedupe "${step.step}" once.key`,
        undefined,
        view,
      );
      return;
    }
    scan(step, at, view);
  };

  // A tool is declared once and may be called from a loop body, where it reads the loop variable and the
  // body's step outputs, so a tool's templates may name any of them.
  const loopNames: string[] = [];

  // Walks a step list. In a foreach body `local` is mutated: a step's name joins it once the step is done, so a
  // later step in the body can read it, an arm's steps included (the arm that ran left them there, ADR-0045).
  // At the top level it is undefined, as every step name is already known.
  const walk = (
    list: readonly (WorkflowStep | BodyStep)[],
    listAt: (string | number)[],
    local: string[] | undefined,
    hidden: ReadonlyMap<string, string>,
  ) => {
    list.forEach((step, i) => {
      const at = [...listAt, i];
      const view: View = { local: local ?? [], hidden };
      // An expression reads `trigger`, `input` and `vars` from the root; a step with one of those names would
      // be hidden by it (the engine gives the reserved name precedence).
      if ((ROOTS as readonly string[]).includes(step.step)) {
        report(
          [...at, "step"],
          `"${step.step}" is a reserved name in a version "1.1" spec (an expression reads ${ROOTS.join(", ")} from the root): rename the step`,
        );
      }
      if ("branch" in step) {
        const b = step.branch;
        const arms = armsOf(step);
        // The condition runs before any arm, so it reads none of their steps.
        const all = new Map(hidden);
        for (const arm of arms) for (const n of namesIn(arm.list)) all.set(n, step.step);
        const head = "if" in b ? b.if : b.switch;
        check(
          [...at, "branch", "if" in b ? "if" : "switch"],
          head,
          `branch "${step.step}" ${"if" in b ? "if" : "switch"}`,
          undefined,
          { local: local ?? [], hidden: all },
        );
        if ("switch" in b) reportDuplicateCases([...at, "branch", "cases"]);
        for (const arm of arms) {
          // What the other arms define is out of reach inside this one.
          const others = new Map(hidden);
          for (const other of arms) {
            if (other === arm) continue;
            for (const n of namesIn(other.list)) others.set(n, step.step);
          }
          walk(arm.list, [...at, ...arm.key], local, others);
        }
      } else if ("foreach" in step) {
        // `items` is read where the loop starts, so it cannot see the loop variable or the body's steps.
        const loop = (step as Extract<WorkflowStep, { foreach: { steps: unknown } }>).foreach;
        check(
          [...at, "foreach", "items"],
          loop.items,
          `foreach "${step.step}" items`,
          undefined,
          view,
        );
        const inner: string[] = [loop.as];
        walk(loop.steps, [...at, "foreach", "steps"], inner, hidden);
        loopNames.push(...inner);
      } else {
        checkLeaf(step, at, view);
      }
      local?.push(step.step);
    });
  };
  // KAN-1848: a webhook's `when` and `map` run when the request arrives, before any step: they read only
  // `trigger` (headers, body, and the body's fields), and are whole expressions, not `{{ }}` text.
  const trigger = spec.agent.trigger;
  if (trigger?.type === "webhook") {
    const checkIngress = (path: (string | number)[], source: string, where: string) => {
      const parsed = parseExpression(source);
      if (!parsed.ok) {
        for (const e of parsed.errors) reportExpression(path, where, e);
        return;
      }
      for (const message of ingressReadIssues(parsed.ast)) report(path, `${where}: ${message}`);
    };
    if (trigger.when !== undefined)
      checkIngress(["agent", "trigger", "when"], trigger.when, "when");
    for (const [name, source] of Object.entries(trigger.map ?? {})) {
      checkIngress(["agent", "trigger", "map", name], source, `map.${name}`);
    }
  }
  walk(spec.agent.workflow, ["agent", "workflow"], undefined, new Map());
  scan(spec.agent.tools, ["agent", "tools"], { local: loopNames, hidden: new Map() });
  return errors;
}
