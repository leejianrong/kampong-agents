import type { Document } from "yaml";

// The canvas write path (PLAN.md Shape S2/S1, ADR-0002) mutates the loaded
// Document in place via setIn/addIn/deleteIn rather than rebuilding plain JS
// and re-stringifying from scratch — that's what keeps comments and
// formatting elsewhere in the file intact across a canvas-triggered save.

export type PatchOp =
  | { op: "set"; path: (string | number)[]; value: unknown }
  | { op: "add"; path: (string | number)[]; value: unknown }
  | { op: "remove"; path: (string | number)[] };

export function applyPatch(doc: Document, ops: PatchOp[]): void {
  for (const op of ops) {
    if (op.op === "set") {
      doc.setIn(op.path, op.value);
    } else if (op.op === "add") {
      // addIn requires the collection at `path` to already exist -- if it
      // doesn't (e.g. adding the first tool to a spec with no `tools:` key
      // yet), it sets the path to the bare value instead of wrapping it in
      // a new array. Create the array explicitly in that case.
      if (doc.getIn(op.path) === undefined) {
        doc.setIn(op.path, [op.value]);
      } else {
        doc.addIn(op.path, op.value);
      }
    } else {
      doc.deleteIn(op.path);
    }
  }
}
