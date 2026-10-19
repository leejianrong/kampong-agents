import { isSeq, parseDocument } from "yaml";
import { buildPragmaLine } from "./pragma.js";

// KAM-196: what a new workflow starts as, and how to tell that a spec has nothing in it yet. Shared by the
// local server (which writes the file on "Start blank") and the hosted canvas, so both start from the same text.

/** Where the published JSON Schema sits relative to a spec, for the editor pragma, when the caller has no better path. */
export const DEFAULT_SCHEMA_PATH = "../packages/spec/schemas/agent-spec.v1.0.schema.json";

export interface BlankSpecOptions {
  /** The agent's `id`: letters, digits and underscores. */
  id?: string;
  /** The agent's display name. */
  name?: string;
  /** Path to the JSON Schema, written into the `yaml-language-server` pragma. */
  schemaPath?: string;
}

/**
 * A minimal spec that validates: the schema needs one step, so there is one for the author to rename and
 * edit. Version "1.0" so every server that runs specs (hosted included) runs it. The pragma is the first line.
 */
export function blankSpecSource(options: BlankSpecOptions = {}): string {
  const { id = "new_workflow", name = "New workflow", schemaPath = DEFAULT_SCHEMA_PATH } = options;
  return `${buildPragmaLine(schemaPath)}
version: "1.0"
agent:
  id: ${id}
  name: ${JSON.stringify(name)}
  role: "Helpful assistant"
  goal: "Answer the user's question concisely and helpfully."
  # The provider must match a model key you have set up (a BYOK key when hosted, or the
  # \${...} variable named below when running locally). The placeholder also satisfies validation.
  model:
    provider: openrouter
    name: liquid/lfm-2.5-2.6b:free
    api_key: \${OPENROUTER_API_KEY}
  workflow:
    - step: answer
      action: generate_text
      inputs: [input]
`;
}

/** True when the text has no content at all: a new, empty file. */
export function isBlankSource(source: string): boolean {
  return source.trim() === "";
}

/**
 * True when the text is a spec whose `agent.workflow` is present and has no steps (`workflow: []`, or the key
 * with nothing after it). The schema refuses that, but the canvas shows "no steps yet", not a broken file.
 */
export function hasEmptyWorkflow(source: string): boolean {
  const doc = parseDocument(source);
  if (doc.errors.length > 0 || !doc.hasIn(["agent", "workflow"])) return false;
  const workflow = doc.getIn(["agent", "workflow"], true);
  if (isSeq(workflow)) return workflow.items.length === 0;
  return doc.getIn(["agent", "workflow"]) === null;
}
