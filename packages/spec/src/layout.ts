// Sidecar layout store (PLAN.md Shape S2, ADR-0006): canvas node positions
// live in `.kampong/layout.json`, never in the spec YAML, so the spec stays
// hand-authorable and diff-clean for a developer who never opens the canvas.

export interface NodePosition {
  x: number;
  y: number;
}

export type LayoutMap = Record<string, NodePosition>;

const SPACING = { x: 260, y: 120 };

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
    maxYByColumn[column] = Math.max(maxYByColumn[column] ?? -SPACING.y, existing.y);
  }

  for (const { id, column } of nodes) {
    if (next[id]) continue;
    const y = (maxYByColumn[column] ?? -SPACING.y) + SPACING.y;
    next[id] = { x: column * SPACING.x, y };
    maxYByColumn[column] = y;
  }
  return next;
}
