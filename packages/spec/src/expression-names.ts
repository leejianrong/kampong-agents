// Which names an expression may read, and the message when it reads one that is not there. One definition for
// the spec loader (spec-expressions.ts, which reports it with a line) and the canvas's expression field
// (expression-assist.ts, which reports it as you type), so the two cannot disagree about a name.

export const EXPRESSION_ROOTS = ["trigger", "input", "vars"] as const;

export interface NameScope {
  varNames: readonly string[];
  /** Every step an expression may name. */
  stepNames: readonly string[];
  /** A foreach body adds the loop variable and the body steps that ran before. */
  local?: readonly string[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The problem with reading `names` (the leading names of a path, as expressionPaths gives them), if any. */
export function nameProblem(names: readonly string[], scope: NameScope): string | undefined {
  const [root, second] = names;
  if (root === undefined) return undefined;
  const local = scope.local ?? [];
  if (root === "vars") {
    if (second !== undefined && !scope.varNames.includes(second)) {
      return (
        `vars.${second} is not declared in vars` +
        (scope.varNames.length > 0
          ? ` (declared: ${scope.varNames.join(", ")})`
          : " (there is no vars block)")
      );
    }
    return undefined;
  }
  if (
    (EXPRESSION_ROOTS as readonly string[]).includes(root) ||
    scope.stepNames.includes(root) ||
    local.includes(root)
  ) {
    return undefined;
  }
  const odd = scope.stepNames.filter((n) => !IDENT.test(n));
  return (
    `"${root}" is not something an expression can read: use trigger, input, vars, ` +
    `or the name of a step (${[...scope.stepNames, ...local].join(", ")})` +
    (odd.length > 0
      ? `. A step name that is not a plain identifier (${odd.join(", ")}) must be written in backticks: \`${odd[0]}\`.field`
      : "")
  );
}
