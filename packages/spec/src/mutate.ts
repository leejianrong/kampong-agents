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
      doc.addIn(op.path, op.value);
    } else {
      doc.deleteIn(op.path);
    }
  }
}
