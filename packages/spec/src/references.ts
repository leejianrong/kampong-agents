import {
  expressionPathNodes,
  parseExpression,
  templateExpressions,
  type ExpressionNode,
} from "./expression.js";
import { parseSpec } from "./parse.js";
import { isObj, rawTools, walkRawSteps, type Path, type RawStep } from "./step-tree.js";

// Where a step name or a tool name is read (ADR-0055 rule 3). The scan is parse-based: a 1.1 expression is
// read with JSONata, so a name inside a string literal, a field name (`order.fetch`) or a lambda parameter is
// not a read; a 1.0 template and the 1.0 condition grammar are read with the same patterns the engine uses.

/**
 * The placeholder pattern the engine resolves in a tool's `url`, `body` and the like, and in a 1.0 step
 * (`substitutePlaceholders` in packages/engine/src/http-tool.ts). Copied rather than imported because that
 * file is vendored into exported projects (ADR-0010); a unit test fails if the two drift.
 */
export const TEMPLATE_REFERENCE_SOURCE = String.raw`\{\{\s*([A-Za-z0-9_.]+)\s*\}\}|\{([A-Za-z0-9_.]+)\}`;
/** The 1.0 condition grammar (`evaluateCondition` in packages/engine/src/condition.ts). Same drift test. */
export const CONDITION_REFERENCE_SOURCE = String.raw`^\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$`;
/** `execute_tool(name)` in a 1.0 condition step's `then` / `else` (packages/engine/src/workflow.ts). */
export const EXECUTE_TOOL_SOURCE = String.raw`^execute_tool\(([A-Za-z0-9_]+)\)$`;

export type ReferenceKind =
  "expression" | "template" | "condition" | "tool" | "tool_template" | "execute_tool";

/** One place a name is read, as reported to a caller. */
export interface Reference {
  /** The YAML path of the field. */
  path: Path;
  kind: ReferenceKind;
  /** The expression, template span, condition or tool name that holds it. */
  text: string;
  line?: number;
}

export interface Occurrence extends Reference {
  target: "step" | "tool";
  name: string;
  /** The whole field text and the span of the name inside it. */
  field: string;
  start: number;
  end: number;
  /** The name was written in backticks (the span includes them). */
  ticked: boolean;
  /** Read by a placeholder pattern, which can only spell a plain name. */
  simple: boolean;
  /** The step (or `tool:<name>`) whose field this is, and that step's place in document order. */
  reader: string;
  readerOrder?: number;
  /** The field's path inside the reader (step or tool), which stays the same when steps move around it. */
  rel?: Path;
  /** The text at the span is not the name (it cannot be rewritten with certainty). */
  unverified: boolean;
}

interface Scan {
  version: "1.0" | "1.1";
  out: Occurrence[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const JSONATA_WORDS = new Set(["and", "or", "in", "true", "false", "null", "function"]);

/** How a name is written in a 1.1 expression: bare when JSONata allows it, else in backticks. */
export function expressionName(name: string): string {
  return IDENT.test(name) && !JSONATA_WORDS.has(name) ? name : `\`${name}\``;
}

function nameOccurrence(
  scan: Scan,
  base: Omit<Occurrence, "name" | "start" | "end" | "ticked" | "unverified" | "text">,
  node: ExpressionNode,
  offset: number,
  text: string,
): void {
  const name = String(node.value);
  const end = (node.position ?? 0) + offset;
  const ticked = base.field[end - 1] === "`";
  const start = end - name.length - (ticked ? 2 : 0);
  const written = base.field.slice(start, end);
  scan.out.push({
    ...base,
    name,
    start,
    end,
    ticked,
    unverified: written !== (ticked ? `\`${name}\`` : name),
    text,
  });
}

function scanExpression(
  scan: Scan,
  base: Omit<Occurrence, "name" | "start" | "end" | "ticked" | "unverified" | "text">,
  source: string,
  offset: number,
  textOf: () => string,
): void {
  const parsed = parseExpression(source);
  if (!parsed.ok) return;
  for (const names of expressionPathNodes(parsed.ast)) {
    const first = names[0];
    if (first) nameOccurrence(scan, base, first, offset, textOf());
  }
}

/** Reads a string that may hold templates. `single` also reads the `{name.field}` form (tools; 1.0 steps). */
function scanTemplate(
  scan: Scan,
  path: Path,
  field: string,
  reader: string,
  readerOrder: number | undefined,
  kind: "template" | "tool_template",
): void {
  const base = {
    target: "step" as const,
    path,
    kind,
    field,
    simple: false,
    reader,
    readerOrder,
  };
  if (scan.version === "1.1") {
    for (const { expression, offset } of templateExpressions(field)) {
      scanExpression(scan, base, expression, offset, () =>
        field.slice(offset - 2, offset + expression.length + 2),
      );
    }
  }
  for (const m of field.matchAll(new RegExp(TEMPLATE_REFERENCE_SOURCE, "g"))) {
    const isDouble = m[1] !== undefined;
    // A 1.1 `{{ }}` was read above, with JSONata. A `${NAME}` is an environment variable, not a placeholder.
    if (isDouble && scan.version === "1.1") continue;
    if (!isDouble && field[m.index - 1] === "$") continue;
    // The `{name.field}` form is a 1.0 step's syntax and a tool's (the engine resolves it in any version).
    if (!isDouble && scan.version === "1.1" && kind === "template") continue;
    const key = (m[1] ?? m[2])!;
    const name = key.split(".")[0]!;
    const start = m.index + m[0].indexOf(key);
    scan.out.push({
      ...base,
      simple: true,
      name,
      start,
      end: start + name.length,
      ticked: false,
      unverified: false,
      text: m[0],
    });
  }
}

function scanValue(
  scan: Scan,
  value: unknown,
  path: Path,
  visit: (path: Path, text: string) => void,
  skip: (rel: Path) => boolean,
  rel: Path = [],
): void {
  if (skip(rel)) return;
  if (typeof value === "string") visit(path, value);
  else if (Array.isArray(value)) {
    value.forEach((v, i) => scanValue(scan, v, [...path, i], visit, skip, [...rel, i]));
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      scanValue(scan, v, [...path, k], visit, skip, [...rel, k]);
    }
  }
}

function toolOccurrence(
  scan: Scan,
  entry: RawStep,
  path: Path,
  field: string,
  kind: "tool" | "execute_tool",
  name: string,
  start: number,
): void {
  scan.out.push({
    target: "tool",
    name,
    path,
    kind,
    text: field,
    field,
    start,
    end: start + name.length,
    ticked: false,
    simple: true,
    reader: entry.name,
    readerOrder: entry.order,
    unverified: false,
  });
}

function scanStep(scan: Scan, entry: RawStep): void {
  const v11 = scan.version === "1.1";
  const s = entry.step;
  const reader = entry.name;
  const readerOrder = entry.order;

  if (typeof s.tool === "string") {
    toolOccurrence(scan, entry, [...entry.path, "tool"], s.tool, "tool", s.tool, 0);
  }
  for (const key of ["then", "else"]) {
    const v = s[key];
    if (typeof v !== "string") continue;
    const m = new RegExp(EXECUTE_TOOL_SOURCE).exec(v);
    if (m) {
      toolOccurrence(
        scan,
        entry,
        [...entry.path, key],
        v,
        "execute_tool",
        m[1]!,
        "execute_tool(".length,
      );
    }
  }

  const isExpression = (rel: Path): boolean =>
    v11 &&
    ((rel.length === 1 && (rel[0] === "if" || rel[0] === "assert")) ||
      (rel[0] === "set" && rel.length === 2) ||
      (rel[0] === "once" && rel[1] === "key") ||
      (rel[0] === "branch" && (rel[1] === "if" || rel[1] === "switch")) ||
      (rel[0] === "foreach" && rel[1] === "items"));
  const skip = (rel: Path): boolean =>
    (rel.length === 1 &&
      ["step", "type", "tool", "inputs", "output_schema", "model", "then", "else"].includes(
        String(rel[0]),
      )) ||
    (rel[0] === "branch" && ["then", "else", "cases", "default"].includes(String(rel[1]))) ||
    (rel[0] === "foreach" && (rel[1] === "steps" || rel[1] === "as"));

  scanValue(
    scan,
    s,
    entry.path,
    (path, text) => {
      const rel = path.slice(entry.path.length);
      if (isExpression(rel)) {
        scanExpression(
          scan,
          {
            target: "step",
            path,
            kind: "expression",
            field: text,
            simple: false,
            reader,
            readerOrder,
          },
          text,
          0,
          () => text,
        );
      } else if (!v11 && rel.length === 1 && rel[0] === "if") {
        const m = new RegExp(CONDITION_REFERENCE_SOURCE).exec(text);
        if (m) {
          const start = text.search(/\S/);
          scan.out.push({
            target: "step",
            name: m[1]!,
            path,
            kind: "condition",
            text,
            field: text,
            start,
            end: start + m[1]!.length,
            ticked: false,
            simple: true,
            reader,
            readerOrder,
            unverified: false,
          });
        }
      } else {
        scanTemplate(scan, path, text, reader, readerOrder, "template");
      }
    },
    skip,
  );
}

/** Every place the spec reads a step or a tool by name, in document order. Works on the raw parsed data. */
export function scanOccurrences(raw: unknown): Occurrence[] {
  const version = isObj(raw) && raw.version === "1.1" ? "1.1" : "1.0";
  const scan: Scan = { version, out: [] };
  for (const entry of walkRawSteps(raw)) {
    const from = scan.out.length;
    scanStep(scan, entry);
    for (const o of scan.out.slice(from)) o.rel = o.path.slice(entry.path.length);
  }
  for (const { index, tool } of rawTools(raw)) {
    const reader = `tool:${String(tool.name)}`;
    const from = scan.out.length;
    scanValue(
      scan,
      tool,
      ["agent", "tools", index],
      (path, text) => scanTemplate(scan, path, text, reader, undefined, "tool_template"),
      (rel) => rel[0] === "name" || rel[0] === "use" || rel[0] === "action",
    );
    for (const o of scan.out.slice(from)) o.rel = o.path.slice(3);
  }
  return scan.out;
}

/** The 1-based line of the node at `path`, when it can be found. */
export function lineOfPath(
  doc: ReturnType<typeof parseSpec>["doc"],
  source: string,
  path: Path,
): number | undefined {
  try {
    const node = doc.getIn(path, true);
    const at =
      node && typeof node === "object" && "range" in node
        ? (node as { range?: number[] | null }).range?.[0]
        : undefined;
    if (at === undefined) return undefined;
    return source.slice(0, at).split("\n").length;
  } catch {
    return undefined;
  }
}

export interface ReferenceQuery {
  step?: string;
  tool?: string;
}

/**
 * Every place `source` reads the named step or tool, with the YAML line of each. `step` also matches the
 * steps inside it only when they are named: ask for each name you care about.
 */
export function findReferences(source: string, query: ReferenceQuery): Reference[] {
  const { doc } = parseSpec(source);
  if (doc.errors.length > 0) return [];
  return occurrencesFor(doc.toJS(), query).map((o) => ({
    path: o.path,
    kind: o.kind,
    text: o.text,
    line: lineOfPath(doc, source, o.path),
  }));
}

export function occurrencesFor(raw: unknown, query: ReferenceQuery): Occurrence[] {
  return scanOccurrences(raw).filter(
    (o) =>
      (query.step !== undefined && o.target === "step" && o.name === query.step) ||
      (query.tool !== undefined && o.target === "tool" && o.name === query.tool),
  );
}
