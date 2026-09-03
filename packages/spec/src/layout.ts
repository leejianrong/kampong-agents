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
  const rowByColumn: Record<number, number> = {};
  for (const { id, column } of nodes) {
    if (next[id]) continue;
    const row = rowByColumn[column] ?? 0;
    next[id] = { x: column * SPACING.x, y: row * SPACING.y };
    rowByColumn[column] = row + 1;
  }
  return next;
}
