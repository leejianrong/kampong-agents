import type { ZodIssue } from "zod";
import { Document, LineCounter, parseDocument, visit, type SchemaOptions } from "yaml";
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
  flowStyles.set(doc, sniffFlowStyle(doc, source));

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

// Flow collections keep the spacing the document was written with (KAM-157). The yaml package has one padding
// setting for maps and sequences together and the parsed nodes do not remember theirs, so `parseSpec` reads each
// kind's style off the source (the character after each `{` or `[`) and the majority wins, separately for maps
// and for sequences: prettier's `{ a: 1 }` with `[a, b]` and the tight `{a: 1}` with `[a, b]` both survive. A
// document that was never parsed from text (a new one) is written tight. A document that mixes the styles is
// normalised to its majority on save.
interface FlowStyle {
  map: boolean;
  seq: boolean;
}
const flowStyles = new WeakMap<Document, FlowStyle>();

function sniffFlowStyle(doc: Document, source: string): FlowStyle {
  const tally = { map: 0, seq: 0 };
  const count = (
    kind: "map" | "seq",
    node: { flow?: boolean; range?: [number, number, number] | null },
  ) => {
    const at = node.range?.[0];
    if (!node.flow || at === undefined) return;
    const next = source[at + 1];
    // An empty collection or one broken across lines says nothing about padding.
    if (next === undefined || next === "}" || next === "]" || next === "\n" || next === "\r")
      return;
    tally[kind] += next === " " ? 1 : -1;
  };
  visit(doc, {
    Map: (_, node) => count("map", node),
    Seq: (_, node) => count("seq", node),
  });
  return { map: tally.map > 0, seq: tally.seq > 0 };
}

const MAP_TAG = "tag:yaml.org,2002:map";
const SEQ_TAG = "tag:yaml.org,2002:seq";
const withFlowPadding =
  (style: FlowStyle): NonNullable<SchemaOptions["customTags"]> =>
  (tags) =>
    tags.map((tag) => {
      if (typeof tag === "string" || (tag.tag !== MAP_TAG && tag.tag !== SEQ_TAG)) return tag;
      const padding = (tag.tag === MAP_TAG ? style.map : style.seq) ? " " : "";
      return {
        ...tag,
        // The stock collection tags have no stringify of their own: a collection prints itself. The padding is
        // set per collection kind because a nested context inherits its parent's.
        stringify: (item, ctx, onComment, onChompKeep) =>
          (item as { toString(...args: unknown[]): string }).toString(
            { ...ctx, flowCollectionPadding: padding },
            onComment,
            onChompKeep,
          ),
      } as typeof tag;
    });

/**
 * Serialises a document without reformatting what an author wrote (KAM-157, ADR-0007's diff-clean goal):
 * `lineWidth: 0` stops long double-quoted, plain and folded (`>-`) scalars being refolded at 80 columns, which
 * would rewrite a hand-authored JSONata expression on every canvas save, and flow collections keep the spacing
 * they were parsed with (see above). A folded block scalar is emitted as one line per paragraph, so a `>-` that
 * was hand-wrapped is unwrapped on save; the value is unchanged. Use `|` where the line breaks matter to you.
 */
export function toYamlString(doc: Document): string {
  const style = flowStyles.get(doc);
  if (!style || (!style.map && !style.seq)) {
    return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  }
  // The schema is fixed when a document is made, so the tags are swapped on a copy; the caller's document
  // (which the canvas keeps editing) is left as it was.
  const copy = doc.clone();
  copy.setSchema(doc.directives?.yaml.version ?? "1.2", { customTags: withFlowPadding(style) });
  return copy.toString({ lineWidth: 0, flowCollectionPadding: false });
}
