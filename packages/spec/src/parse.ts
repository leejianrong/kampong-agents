import type { ZodIssue } from "zod";
import { Document, LineCounter, parseDocument } from "yaml";
import { agentSpecSchema, type AgentSpec } from "./schema.js";

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
    const errors = result.error.issues.map((issue) => toSpecError(issue, doc, lineCounter));
    return { success: false, doc, errors };
  }

  return { success: true, spec: result.data, doc, errors: [] };
}

function toSpecError(issue: ZodIssue, doc: Document, lineCounter: LineCounter): SpecError {
  let line: number | undefined;
  let column: number | undefined;
  try {
    const node = doc.getIn(issue.path, true) as { range?: [number, number, number] } | null;
    if (node && typeof node === "object" && "range" in node && node.range) {
      const pos = lineCounter.linePos(node.range[0]);
      line = pos.line;
      column = pos.col;
    }
  } catch {
    // The path doesn't resolve to a concrete node (e.g. a missing required
    // field has nothing to point at) — position stays undefined.
  }
  return { path: issue.path, message: issue.message, line, column };
}

export function toYamlString(doc: Document): string {
  // flowCollectionPadding: false matches conventional hand-written YAML
  // ([a, b], not [ a, b ]) so re-serializing an untouched document is a true
  // no-op rather than a cosmetic reformat on every save.
  return doc.toString({ flowCollectionPadding: false });
}
