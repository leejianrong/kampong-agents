// Vendored, unmodified, from packages/engine/src/condition.ts (this repo's
// tested execution engine) as part of a `kampong export` -- see this repo's
// docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md for why this
// is a copy of real, tested logic rather than a re-templated
// reimplementation. From here on this file is yours: it has no dependency
// on the tool that generated it (ADR-0002), and it will not be touched again
// by a future export.
//
// Evaluates a workflow condition step's `if` expression against real prior
// step outputs.
//
// Design decision (documented here since the spec schema leaves `if` as an
// opaque string): this supports the minimal grammar --
// `<step_id>.<field> <op> <literal>`, where `<step_id>` names a workflow
// step that has already run. `<op>` is one of == != > >= < <=. `<literal>`
// is `true`/`false`, a number, or a quoted string. Anything richer
// (boolean combinators, arbitrary expressions) is out of scope and would
// need a real expression parser, not a regex.

const CONDITION_PATTERN = /^\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/;

export function evaluateCondition(expr: string, stepOutputs: Record<string, unknown>): boolean {
  const match = CONDITION_PATTERN.exec(expr);
  if (!match) {
    throw new Error(
      `Unrecognized condition expression: "${expr}". Expected "<step_id>.<field> <op> <value>".`,
    );
  }
  const [, stepId, field, op, rawValue] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (!(stepId in stepOutputs)) {
    throw new Error(
      `Condition "${expr}" references step "${stepId}", which has not produced output yet (check step ordering).`,
    );
  }

  const stepOutput = stepOutputs[stepId];
  const actual =
    stepOutput && typeof stepOutput === "object"
      ? (stepOutput as Record<string, unknown>)[field]
      : undefined;
  const expected = parseLiteral(rawValue);

  switch (op) {
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case ">":
      return Number(actual) > Number(expected);
    case ">=":
      return Number(actual) >= Number(expected);
    case "<":
      return Number(actual) < Number(expected);
    case "<=":
      return Number(actual) <= Number(expected);
    default:
      throw new Error(`Unsupported condition operator: "${op}".`);
  }
}

function parseLiteral(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const doubleQuoted = /^"(.*)"$/.exec(raw);
  if (doubleQuoted) return doubleQuoted[1];
  const singleQuoted = /^'(.*)'$/.exec(raw);
  if (singleQuoted) return singleQuoted[1];
  return raw;
}
