import type { ZodIssue } from "zod";
import { Document, LineCounter, parseDocument } from "yaml";
import { agentSpecSchema, type AgentSpec } from "./schema.js";
import { validateSpecExpressions } from "./spec-expressions.js";

// AgentSpec parser/validator (PLAN.md Shape S1, ADR-0002: YAML is the
// single lossless source of truth). Uses the `yaml` package's Document API
// (not js-yaml) so comments and formatting survive a mutate-and-stringify
// round trip (ADR-0007) — the whole reason the canvas mutates this Document
// in place (see mutate.ts) rather than reconstructing plain JS and
// re-serializing from scratch.

export interface SpecError {
  path: (string | number)[];
  message: string;
  line?: number;
  column?: number;
}

export interface ParseResult {
  success: boolean;
  spec?: AgentSpec;
  doc: Document;
  errors: SpecError[];
}

export function parseSpec(source: string): ParseResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, keepSourceTokens: true });

  const syntaxErrors: SpecError[] = doc.errors.map((err) => ({
    path: [],
    message: err.message,
    line: err.linePos?.[0]?.line,
    column: err.linePos?.[0]?.col,
  }));

  if (syntaxErrors.length > 0) {
    return { success: false, doc, errors: syntaxErrors };
  }

  const value = doc.toJS();
  const result = agentSpecSchema.safeParse(value);

  if (!result.success) {
    const errors = result.error.issues
      .flatMap((issue) => expandStepUnion(issue, value))
      .map((issue) => toSpecError(issue, doc, lineCounter));
    return { success: false, doc, errors };
  }

  // Expressions are checked after the shape, so a malformed spec reports its shape first.
  const expressionErrors = validateSpecExpressions(result.data, doc, lineCounter);
  if (expressionErrors.length > 0) {
    return { success: false, doc, errors: expressionErrors };
  }

  return { success: true, spec: result.data, doc, errors: [] };
}

// A workflow step is a union of many shapes, and a union failure says only "Invalid input" at the step. For a
// branch or a stop (KAN-1859) the step names its kind by its key, so the issues of that kind's own shape are the
// ones worth showing, at the line they are on. A nested step in an arm is a union again, so this recurses.
function expandStepUnion(issue: ZodIssue, root: unknown): ZodIssue[] {
  if (issue.code !== "invalid_union") return [issue];
  let value: unknown = root;
  for (const segment of issue.path) {
    value =
      value !== null && typeof value === "object"
        ? (value as Record<PropertyKey, unknown>)[segment]
        : undefined;
  }
  if (value === null || typeof value !== "object") return [issue];
  let group: ZodIssue[] | undefined;
  if (issue.path[issue.path.length - 1] === "branch") {
    // The two forms of a branch, in the order the schema lists them: if/then/else, then switch/cases/default.
    group = issue.errors["if" in (value as object) ? 0 : 1];
  } else {
    const key = (["branch", "stop"] as const).find((k) => k in (value as object));
    if (key === undefined) return [issue];
    group = issue.errors.find((errs) => errs.some((e) => e.path[0] === key));
  }
  if (!group) return [issue];
  return group.flatMap((sub) =>
    expandStepUnion({ ...sub, path: [...issue.path, ...sub.path] } as ZodIssue, root),
  );
}

// Zod v4 widened `ZodIssue.path` to `PropertyKey[]` (adding `symbol`) to
// cover schemas keyed by symbol (ours never are -- AgentSpec is plain
// object/array paths only). Narrow back to the `(string | number)[]` this
// module's `SpecError` and `yaml`'s `Document#getIn` both expect.
function toSafePath(path: readonly PropertyKey[]): (string | number)[] {
  return path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment));
}

/** Maps a Zod issue to a `SpecError` with a line and column when the path resolves to a node. */
export function toSpecError(issue: ZodIssue, doc: Document, lineCounter: LineCounter): SpecError {
  const path = toSafePath(issue.path);
  let line: number | undefined;
  let column: number | undefined;
  try {
    const node = doc.getIn(path, true) as { range?: [number, number, number] } | null;
    if (node && typeof node === "object" && "range" in node && node.range) {
      const pos = lineCounter.linePos(node.range[0]);
      line = pos.line;
      column = pos.col;
    }
  } catch {
    // The path doesn't resolve to a concrete node (e.g. a missing required
    // field has nothing to point at) — position stays undefined.
  }
  return { path, message: issue.message, line, column };
}

export function toYamlString(doc: Document): string {
  // flowCollectionPadding: false matches conventional hand-written YAML
  // ([a, b], not [ a, b ]) so re-serializing an untouched document is a true
  // no-op rather than a cosmetic reformat on every save.
  return doc.toString({ flowCollectionPadding: false });
}
