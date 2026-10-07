import jsonata from "jsonata";

// Evaluating expressions (KAN-1841, ADR-0027). A version "1.1" spec computes values with JSONata: a
// condition, and each `{{ … }}` in a tool, a step's query or an approval message. This file is the whole
// contract for doing that safely, built from what the spike (KAN-1839) measured:
//
//  - pure: the clock, randomness and `$eval` are refused, and nothing outside the data is reachable;
//  - bounded: a time limit and a depth limit (JSONata's own), a step budget and size limits (a hook on every
//    node), `$pad` capped, and no regular expressions, which cannot be interrupted;
//  - located: every failure is an ExpressionError with a code, a position, and the expression it came from.
//
// It is vendored into exports (ADR-0010), so it imports nothing from @kampong/spec or the rest of the engine.
// The validator in @kampong/spec applies the same parse-time rules when a spec loads; a test keeps the two
// lists in step. Memory is bounded in this process only softly (see the ADR): a hosted server must run
// expressions behind a process boundary before it enables them.

export interface ExpressionLimits {
  /** Wall-clock budget for one evaluation, in milliseconds. */
  timeoutMs: number;
  /** Deepest nesting of calls (a runaway recursion hits this). */
  stack: number;
  /** Most syntax-tree nodes one evaluation may visit. */
  steps: number;
  /** Longest string any node may produce. */
  stringChars: number;
  /** Longest list any node may produce. */
  listItems: number;
  /** Longest list `$sort` or `$distinct` will take. */
  sortItems: number;
  /** Longest expression accepted. */
  sourceChars: number;
}

export const DEFAULT_EXPRESSION_LIMITS: ExpressionLimits = {
  timeoutMs: 1000,
  stack: 400,
  steps: 2_000_000,
  stringChars: 1_000_000,
  listItems: 200_000,
  sortItems: 10_000,
  sourceChars: 4000,
};

/** Built-ins that are not a pure function of the data: the clock, randomness, and running a string as code. */
export const DENIED_FUNCTIONS = ["now", "millis", "random", "shuffle", "eval"] as const;

export class ExpressionError extends Error {
  constructor(
    message: string,
    /** JSONata's code (`S0201`, `T2001`, `D1012`) or ours (`K…`). */
    public readonly code: string,
    /** The expression that failed. */
    public readonly expression: string,
    /** Character offset into the expression, when known. */
    public readonly position?: number,
    public readonly line?: number,
    public readonly column?: number,
  ) {
    super(message);
    this.name = "ExpressionError";
  }
}

interface Node {
  type?: string;
  value?: unknown;
  position?: number;
  [key: string]: unknown;
}

function fail(source: string, message: string, code: string, position?: number): ExpressionError {
  if (position === undefined) return new ExpressionError(message, code, source);
  const before = source.slice(0, position);
  return new ExpressionError(
    `${message} (character ${position})`,
    code,
    source,
    position,
    before.split("\n").length,
    position - before.lastIndexOf("\n"),
  );
}

/** JSONata throws plain objects, not Errors, with `{ code, message, position }`. */
function normalise(source: string, thrown: unknown): ExpressionError {
  if (thrown instanceof ExpressionError) return thrown;
  const e = (thrown ?? {}) as { code?: unknown; message?: unknown; position?: unknown };
  const message = typeof e.message === "string" ? e.message : String(thrown);
  return fail(
    source,
    message,
    typeof e.code === "string" ? e.code : "E0000",
    typeof e.position === "number" ? e.position : undefined,
  );
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  if (typeof n.type === "string") visit(n);
  for (const value of Object.values(n)) {
    if (value && typeof value === "object") walk(value, visit);
  }
}

interface NativeFunction {
  implementation: (this: unknown, ...args: unknown[]) => unknown;
  signature?: { definition?: string };
}
const natives = new Map<string, Promise<NativeFunction>>();
/** JSONata's own built-in by name (its function object), fetched once, so a guarded wrapper can delegate to it. */
function originalNative(name: string): Promise<NativeFunction> {
  let found = natives.get(name);
  if (!found) {
    found = (jsonata(`$${name}`).evaluate({}) as Promise<NativeFunction>).catch((err: unknown) => {
      natives.delete(name); // never cache a failure
      throw err;
    });
    natives.set(name, found);
  }
  return found;
}

const ENTRY = Symbol.for("jsonata.__evaluate_entry");
const EXIT = Symbol.for("jsonata.__evaluate_exit");

/**
 * Evaluates one expression against `data` and returns its value (`undefined` when it selects nothing).
 * Throws an ExpressionError for a syntax error, a run-time error, a refused construct, or a limit.
 */
export async function evaluateExpression(
  source: string,
  data: unknown,
  limits: Partial<ExpressionLimits> = {},
): Promise<unknown> {
  const lim = { ...DEFAULT_EXPRESSION_LIMITS, ...limits };
  if (source.trim() === "") throw fail(source, "The expression is empty", "K0001");
  if (source.length > lim.sourceChars) {
    throw fail(
      source,
      `The expression is ${source.length} characters long; the limit is ${lim.sourceChars}`,
      "K0002",
    );
  }

  let expr: ReturnType<typeof jsonata>;
  try {
    expr = jsonata(source, { timeout: lim.timeoutMs, stack: lim.stack });
  } catch (thrown) {
    throw normalise(source, thrown);
  }

  // Refused before anything runs. Found in the syntax tree, so aliasing one (`$f := $now`) or passing it
  // as a value (`$map(a, $random)`) is caught as well.
  let refused: ExpressionError | undefined;
  walk(expr.ast(), (n) => {
    if (refused) return;
    if (n.type === "variable" && (DENIED_FUNCTIONS as readonly unknown[]).includes(n.value)) {
      refused = fail(
        source,
        `$${String(n.value)} is not available: its result is not a function of the input alone`,
        "K0003",
        n.position,
      );
    } else if (n.type === "regex") {
      refused = fail(
        source,
        "Regular expressions are not available in expressions",
        "K0004",
        n.position,
      );
    }
  });
  if (refused) throw refused;

  // A per-evaluation counter, hooked into every node. (JSONata looks the hooks up by these symbols; a
  // string name does nothing.)
  let steps = 0;
  const assign = expr.assign.bind(expr) as (name: string | symbol, value: unknown) => void;
  assign(ENTRY, () => {
    if (++steps > lim.steps) {
      throw fail(source, `The expression needed more than ${lim.steps} steps`, "K0005");
    }
  });
  assign(EXIT, (_e: unknown, _i: unknown, _env: unknown, result: unknown) => {
    if (typeof result === "string" && result.length > lim.stringChars) {
      throw fail(
        source,
        `The expression produced a string longer than ${lim.stringChars} characters`,
        "K0006",
      );
    }
    if (Array.isArray(result) && result.length > lim.listItems) {
      throw fail(
        source,
        `The expression produced a list longer than ${lim.listItems} items`,
        "K0006",
      );
    }
  });

  const [pad, sort, distinct] = await Promise.all(
    ["pad", "sort", "distinct"].map((name) => originalNative(name)),
  );
  // `$sort` and `$distinct` do their work inside one native call, which no per-node hook or timeout can
  // interrupt, and `$sort` uses memory that grows with the square of the list (60 000 numbers exhausted a
  // 2 GB heap), so the list they are given is capped up front. `$pad` allocates before any hook can see
  // the result, so its width is. Each keeps JSONata's own signature, so `$ ~> $sort()` and argument checks
  // still work.
  const guard = (name: string, native: NativeFunction, check: (args: unknown[]) => void) => {
    expr.registerFunction(
      name,
      function (this: unknown, ...args: unknown[]) {
        check(args);
        return native.implementation.apply(this, args);
      },
      native.signature?.definition,
    );
  };
  guard("pad", pad!, (args) => {
    if (typeof args[1] === "number" && Math.abs(args[1]) > lim.stringChars) {
      throw fail(source, `$pad width ${args[1]} is larger than ${lim.stringChars}`, "K0006");
    }
  });
  for (const [name, native] of [
    ["sort", sort!],
    ["distinct", distinct!],
  ] as const) {
    guard(name, native, (args) => {
      const list = args[0];
      if (Array.isArray(list) && list.length > lim.sortItems) {
        throw fail(
          source,
          `$${name} was given ${list.length} items; the limit is ${lim.sortItems}`,
          "K0011",
        );
      }
    });
  }

  // Defence in depth: the denied built-ins throw if anything still reaches them.
  const refuse = (name: string) => () => {
    throw fail(source, `$${name} is not available`, "K0003");
  };
  const bindings: Record<string, unknown> = Object.fromEntries(
    DENIED_FUNCTIONS.map((name) => [name, refuse(name)]),
  );

  let result: unknown;
  try {
    result = await expr.evaluate(data, bindings);
  } catch (thrown) {
    throw normalise(source, thrown);
  }
  // JSONata marks a list it built (`sequence`) and represents a function as an object; neither is data.
  if (
    typeof result === "function" ||
    (result !== null && typeof result === "object" && "_jsonata_lambda" in result) ||
    (result !== null && typeof result === "object" && "_jsonata_function" in result)
  ) {
    throw fail(source, "The expression evaluates to a function, not a value", "K0007");
  }
  // Plain JSON: no `sequence` marker on lists, and anything JSON cannot hold (a function nested inside) is dropped.
  return result === undefined ? undefined : (JSON.parse(JSON.stringify(result)) as unknown);
}

// ---- Conditions ------------------------------------------------------------------------------------

/**
 * A condition must come out true or false. Nothing (a name it reads is missing) and any other type are
 * errors rather than a quiet false: a condition on nothing is a bug, and `$boolean(x)` says what is meant
 * when truthiness is.
 */
export async function evaluateCondition(
  source: string,
  data: unknown,
  limits?: Partial<ExpressionLimits>,
): Promise<boolean> {
  const value = await evaluateExpression(source, data, limits);
  if (typeof value === "boolean") return value;
  if (value === undefined) {
    throw fail(
      source,
      "The condition evaluated to nothing: a name it reads is missing from the data (use $exists(...) to test whether it is there)",
      "K0008",
    );
  }
  throw fail(
    source,
    `The condition must evaluate to true or false, not ${Array.isArray(value) ? "a list" : typeof value}; use $boolean(...) to test truthiness`,
    "K0009",
  );
}

// ---- Templates (`{{ expression }}` inside text) ------------------------------------------------------

export interface TemplateSpan {
  expression: string;
  /** Where the expression starts inside the text. */
  offset: number;
  /** The `{{` and the end of the `}}`, for replacing the whole span. */
  start: number;
  end: number;
}

/**
 * The `{{ … }}` spans in a string. The end is the first `}}` that is not inside a string literal or a
 * brace the expression opened, so an object constructor (`{{ {"a": {"b": 1}}.a }}`) and a string holding
 * `}}` are read whole. An opening `{{` with no end is plain text.
 */
export function templateSpans(text: string): TemplateSpan[] {
  const out: TemplateSpan[] = [];
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
    out.push({ expression: text.slice(start + 2, end), offset: start + 2, start, end: end + 2 });
    i = end + 2;
  }
  return out;
}

function asText(source: string, value: unknown): string {
  if (value === undefined) {
    throw fail(source, "evaluated to nothing: a name it reads is missing from the data", "K0010");
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** How the resolved text is going to be used, so a value cannot be read back as author text. */
export interface ResolveOptions {
  limits?: Partial<ExpressionLimits>;
  /** Keys whose values are left alone (resolveTemplatesDeep). */
  skip?: ReadonlySet<string>;
  /**
   * Applied to every string that comes from data (an evaluated value, text built from one, and strings
   * inside a list or object value) and not to the author's own text. A later pass that reads `${ENV}` or
   * `{name}` tokens uses it to keep a webhook body from smuggling one in.
   */
  escapeData?: (text: string) => string;
  /** One time budget (ms) shared by every expression in the call; each evaluation gets what is left. */
  totalTimeoutMs?: number;
}

function escapeDeep(value: unknown, escape: (text: string) => string): unknown {
  if (typeof value === "string") return escape(value);
  if (Array.isArray(value)) return value.map((v) => escapeDeep(v, escape));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [escape(k), escapeDeep(v, escape)]),
    );
  }
  return value;
}

interface Budget {
  evaluate(source: string, data: unknown): Promise<unknown>;
}

function budgetFor(options: ResolveOptions): Budget {
  const lim = { ...DEFAULT_EXPRESSION_LIMITS, ...options.limits };
  const total = options.totalTimeoutMs ?? lim.timeoutMs;
  const deadline = Date.now() + total;
  return {
    async evaluate(source, data) {
      const left = deadline - Date.now();
      if (left <= 0) {
        throw fail(
          source,
          `The expressions in this field took longer than ${total}ms in all`,
          "K0012",
        );
      }
      return evaluateExpression(source, data, {
        ...options.limits,
        timeoutMs: Math.min(lim.timeoutMs, left),
      });
    },
  };
}

/**
 * Resolves the `{{ expression }}` spans in a string. A string that is exactly one span keeps the value's
 * type (a number stays a number, a list a list), so a component input can be filled with real data; text
 * around spans is built from each value (a string as is, a number or boolean as its text, anything else as
 * JSON). A span that evaluates to nothing is an error.
 */
export async function resolveTemplate(
  text: string,
  data: unknown,
  options: ResolveOptions | Partial<ExpressionLimits> = {},
  budget: Budget = budgetFor(normaliseOptions(options)),
): Promise<unknown> {
  const opts = normaliseOptions(options);
  const escape = opts.escapeData;
  const spans = templateSpans(text);
  if (spans.length === 0) return text;
  const only = spans.length === 1 && spans[0]!.start === 0 && spans[0]!.end === text.length;
  if (only) {
    const value = await budget.evaluate(spans[0]!.expression, data);
    if (value === undefined) {
      throw fail(
        spans[0]!.expression,
        `{{ ${spans[0]!.expression.trim()} }} evaluated to nothing: a name it reads is missing from the data`,
        "K0010",
      );
    }
    return escape ? escapeDeep(value, escape) : value;
  }
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start);
    const value = await budget.evaluate(span.expression, data);
    let piece: string;
    try {
      piece = asText(span.expression, value);
    } catch {
      throw fail(
        span.expression,
        `{{ ${span.expression.trim()} }} evaluated to nothing: a name it reads is missing from the data`,
        "K0010",
      );
    }
    out += escape ? escape(piece) : piece;
    at = span.end;
  }
  return out + text.slice(at);
}

// `resolveTemplate(text, data, limits)` took the limits directly; an options object is told apart by the keys
// only it has.
function normaliseOptions(options: ResolveOptions | Partial<ExpressionLimits>): ResolveOptions {
  const o = options as Record<string, unknown>;
  return "limits" in o || "skip" in o || "escapeData" in o || "totalTimeoutMs" in o
    ? (options as ResolveOptions)
    : { limits: options as Partial<ExpressionLimits> };
}

/** Resolves every string in a value (not the keys), leaving the rest as it is. */
export async function resolveTemplatesDeep(
  value: unknown,
  data: unknown,
  options: ResolveOptions = {},
): Promise<unknown> {
  // One budget for the whole structure, and one evaluation at a time, so a field with many slow spans
  // cannot take many times the limit, and which error is reported does not depend on timing.
  const budget = budgetFor(options);
  const walk = async (node: unknown): Promise<unknown> => {
    if (typeof node === "string") return resolveTemplate(node, data, options, budget);
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const entry of node) out.push(await walk(entry));
      return out;
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node)) {
        out[key] = options.skip?.has(key) ? entry : await walk(entry);
      }
      return out;
    }
    return node;
  };
  return walk(value);
}
