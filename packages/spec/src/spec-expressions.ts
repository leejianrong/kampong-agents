import { isMap, isScalar, type Document, type LineCounter } from "yaml";
import {
  expressionPaths,
  parseExpression,
  templateExpressions,
  type ExpressionError,
} from "./expression.js";
import { EXPRESSION_ROOTS, nameProblem } from "./expression-names.js";
import type { SpecError } from "./parse.js";
import type { AgentSpec, BodyStep, BranchStep, WorkflowStep } from "./schema.js";

// Checks every expression in a version "1.1" spec when it is parsed (KAN-1840): a condition's `if`, and
// each `{{ … }}` in a tool or a step. A bad expression is a validation error with the line it is on and
// where in the expression, and a name that nothing provides (a typo in `vars.threshhold`, a step that does
// not exist) is an error too: such a reference does not fail at run time, it evaluates to nothing, and a
// condition on nothing is silently false (ADR-0027, spike result).

const ROOTS = EXPRESSION_ROOTS;

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
    for (const names of expressionPaths(parsed.ast)) {
      const [root] = names;
      if (root === undefined) continue;
      const sibling = view.hidden.get(root);
      if (sibling !== undefined) {
        report(
          path,
          `${where}${here}: "${root}" is a step in another arm of branch "${sibling}", which may not run: ` +
            `its output is not available here (read it after the branch, where it is present only if that arm ran)`,
        );
      } else {
        const problem = nameProblem(names, { varNames, stepNames, local });
        if (problem !== undefined) report(path, `${where}${here}: ${problem}`);
      }
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
      for (const [root] of expressionPaths(parsed.ast)) {
        if (root !== undefined && root !== "trigger") {
          report(
            path,
            `${where}: "${root}" is not available when a request arrives: it can read only trigger (trigger.headers, trigger.body, and the body's fields)`,
          );
        }
      }
    };
    if (trigger.when !== undefined)
      checkIngress(["agent", "trigger", "when"], trigger.when, "when");
    for (const [name, source] of Object.entries(trigger.map ?? {})) {
      checkIngress(["agent", "trigger", "map", name], source, `map.${name}`);
    }
  }
  // KAM-117: a poll's `items` reads the op's result and `id` one item, both before any run exists, so they
  // are checked for syntax only: their names are the result's own, not the spec's.
  if (trigger?.type === "poll") {
    for (const field of ["items", "id"] as const) {
      const source = trigger[field];
      if (source === undefined) continue;
      const parsed = parseExpression(source);
      if (!parsed.ok) {
        for (const e of parsed.errors) reportExpression(["agent", "trigger", field], field, e);
      }
    }
  }
  walk(spec.agent.workflow, ["agent", "workflow"], undefined, new Map());
  scan(spec.agent.tools, ["agent", "tools"], { local: loopNames, hidden: new Map() });
  return errors;
}
