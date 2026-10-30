// Sidecar layout store (PLAN.md Shape S2, ADR-0006): canvas node positions
// live in `.kampong/layout.json`, never in the spec YAML, so the spec stays
// hand-authorable and diff-clean for a developer who never opens the canvas.

import { toolUsage, type SpecGraph } from "./graph.js";

export interface NodePosition {
  x: number;
  y: number;
  /**
   * KAM-186 (ADR-0061): the person dragged this node here. A pinned position overrides the automatic one and
   * survives a reload; an entry without it is only a cache of the automatic layout.
   */
  pinned?: true;
}

export type LayoutMap = Record<string, NodePosition>;

const SPACING = { x: 260, y: 140 };
// The left-to-right layout: a column is a 240 px card and an 80 px gap.
const FLOW = { x: 320, y: 140 };

export function parseLayout(source: string): LayoutMap {
  if (!source.trim()) return {};
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== "object" || parsed === null) return {};
  return parsed as LayoutMap;
}

export function serializeLayout(layout: LayoutMap): string {
  return `${JSON.stringify(layout, null, 2)}\n`;
}

/**
 * Any node id missing from the stored layout gets a deterministic position
 * in a simple column-per-kind grid, so the canvas never renders a node with
 * no position (ADR-0006) — a developer hand-adding a step to the YAML, or an
 * agentic tool generating a spec from scratch, never needs to touch the
 * sidecar file for the canvas to render correctly.
 */
export function withAutoLayout(
  layout: LayoutMap,
  nodes: { id: string; column: number }[],
): LayoutMap {
  const next: LayoutMap = { ...layout };

  // Seed each column's next-free-row from the y-coordinates already present
  // in the incoming `layout`, instead of resetting to empty on every call.
  // `loadWithLayout` (packages/cli/src/spec-store.ts) calls this on every
  // refresh, not just the first one -- if we reset here, a later call (e.g.
  // triggered by "Add Workflow Step") forgets the rows an earlier call
  // already assigned and hands the one new node row 0 again, landing it
  // exactly on top of whatever's already there in that column.
  //
  // "Next free row" is defined as one past the highest occupied row in that
  // column (append-only): a gap left by a deleted node (row 0 and row 2
  // occupied, row 1 empty) is NOT backfilled. This is simpler to reason
  // about and means a node's assigned row never shifts just because some
  // unrelated node elsewhere in the same column was removed.
  const maxYByColumn: Record<number, number> = {};
  for (const { id, column } of nodes) {
    const existing = layout[id];
    if (!existing) continue;
    const row = Math.floor(column);
    maxYByColumn[row] = Math.max(maxYByColumn[row] ?? -SPACING.y, existing.y);
  }

  for (const { id, column } of nodes) {
    if (next[id]) continue;
    // Rows are counted per whole column, so a foreach's indented body steps follow their loop down the same rows.
    const row = Math.floor(column);
    const y = (maxYByColumn[row] ?? -SPACING.y) + SPACING.y;
    next[id] = { x: column * SPACING.x, y };
    maxYByColumn[row] = y;
  }
  return next;
}

/**
 * KAM-238 (ADR-0059): the canvas flows left to right. A node's column is how many steps lie before it, and a
 * branch's second and later arms drop to rows below the first. Stored positions are only a cache of this layout,
 * so it is recomputed from the graph rather than appended to; the exception is a position the person pinned by
 * dragging (KAM-186, ADR-0061; see `layoutWithPins`).
 *
 * `LAYOUT_MARK` is a reserved entry (not a node) that says which layout produced the stored positions; a layout
 * without it is the old top-to-bottom one and is replaced.
 */
export const LAYOUT_MARK = "$layout";
const LAYOUT_VERSION = 2;

export function isCurrentLayout(layout: LayoutMap): boolean {
  return layout[LAYOUT_MARK]?.x === LAYOUT_VERSION;
}

/**
 * Lays the graph out automatically, then lets every pinned position in `stored` override its node's place
 * (ADR-0061). A pin of a node that is no longer in the graph is dropped. Nothing else about the stored layout
 * is trusted: unpinned entries are recomputed.
 */
/** A pinned position must be a finite number within this bound (a hand-edited 1e308 would break the canvas). */
export const PIN_BOUND = 100_000;
export const isSanePin = (at: { x: number; y: number }): boolean =>
  Number.isFinite(at.x) &&
  Number.isFinite(at.y) &&
  Math.abs(at.x) <= PIN_BOUND &&
  Math.abs(at.y) <= PIN_BOUND;

export function layoutWithPins(graph: SpecGraph, stored: LayoutMap): LayoutMap {
  const out = autoLayoutGraph(graph);
  for (const node of graph.nodes) {
    const at = stored[node.id];
    if (at?.pinned === true && isSanePin(at)) {
      out[node.id] = { x: at.x, y: at.y, pinned: true };
    }
  }
  return out;
}

export function autoLayoutGraph(graph: SpecGraph): LayoutMap {
  const out: LayoutMap = { [LAYOUT_MARK]: { x: LAYOUT_VERSION, y: 0 } };
  const flow = graph.nodes.filter((n) => n.kind === "agent" || n.kind === "workflow");
  const flowIds = new Set(flow.map((n) => n.id));
  const preds = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!flowIds.has(e.source) || !flowIds.has(e.target)) continue;
    preds.set(e.target, [...(preds.get(e.target) ?? []), e.source]);
  }

  const depth = new Map<string, number>();
  const row = new Map<string, number>();
  const taken = new Set<string>();
  const children = new Map<string, number>();
  let lowest = 0;

  for (const { id } of flow) {
    const ps = preds.get(id) ?? [];
    const d = ps.length === 0 ? 0 : Math.max(...ps.map((p) => depth.get(p) ?? 0)) + 1;
    let r = 0;
    if (ps.length > 1) {
      r = Math.min(...ps.map((p) => row.get(p) ?? 0));
    } else if (ps.length === 1) {
      const parent = ps[0]!;
      const claimed = children.get(parent) ?? 0;
      children.set(parent, claimed + 1);
      r = claimed === 0 ? (row.get(parent) ?? 0) : lowest + 1;
    }
    while (taken.has(`${d},${r}`)) r++;
    taken.add(`${d},${r}`);
    depth.set(id, d);
    row.set(id, r);
    lowest = Math.max(lowest, r);
    out[id] = { x: d * FLOW.x, y: r * FLOW.y };
  }

  const usage = toolUsage(graph);
  const usedX = new Set<number>();
  for (const node of graph.nodes) {
    if (node.kind !== "tool") continue;
    const anchor = usage[node.id]?.[0];
    let x = anchor !== undefined ? (out[anchor]?.x ?? 0) : 0;
    while (usedX.has(x)) x += FLOW.x;
    usedX.add(x);
    out[node.id] = { x, y: (lowest + 1) * FLOW.y };
  }
  for (const node of graph.nodes) {
    if (node.kind === "guardrails") out[node.id] = { x: 0, y: -FLOW.y };
  }
  return out;
}
