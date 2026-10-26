import type { AssistantDiff } from "./assistant.js";
import { specToGraph, type SpecEdge, type SpecGraph, type SpecNode } from "./graph.js";
import { autoLayoutGraph, type LayoutMap } from "./layout.js";
import type { AgentSpec } from "./schema.js";

// KAM-206 (ADR-0060): what a plan would do, drawn before it is applied. The preview is the workflow as it would be
// with the plan applied, plus the steps and tools the plan removes (kept in their old place and marked), with each
// node that is added, changed or removed marked as such. It is only a view: nothing here is saved, and the layout
// is laid out again for it.

export type PreviewMark = "add" | "change" | "remove";

export interface PlanPreview {
  graph: SpecGraph;
  layout: LayoutMap;
  /** By node id (`workflow:<step>`, `tool:<name>`, or the trigger's `agent:<id>` for a change to the agent's settings). */
  marks: Record<string, PreviewMark>;
}

export function planPreview(
  current: AgentSpec,
  proposed: AgentSpec,
  diff: AssistantDiff,
): PlanPreview {
  const before = specToGraph(current);
  const after = specToGraph(proposed);
  const agentId = after.nodes.find((n) => n.kind === "agent")?.id;

  const idOf = (kind: string, name: string): string | undefined =>
    kind === "step" ? `workflow:${name}` : kind === "tool" ? `tool:${name}` : agentId;
  const marks: Record<string, PreviewMark> = {};
  for (const [list, mark] of [
    [diff.added, "add"],
    [diff.changed, "change"],
    [diff.removed, "remove"],
  ] as const) {
    for (const item of list) {
      // A variable has no card; a change to the settings is shown on the trigger's card.
      if (item.kind === "var") continue;
      if (item.kind === "agent" && mark === "add") continue;
      const id = idOf(item.kind, item.name);
      if (id !== undefined && !(id in marks)) marks[id] = mark;
    }
  }

  // The nodes as they would be, with a removed one slipped in right after whatever came before it, so the run
  // order (which the layout reads) still holds.
  const merged: SpecNode[] = [...after.nodes];
  const present = new Set(merged.map((n) => n.id));
  before.nodes.forEach((node, i) => {
    if (present.has(node.id) || marks[node.id] !== "remove") return;
    let at = -1;
    for (let j = i - 1; j >= 0 && at < 0; j--) {
      at = merged.findIndex((n) => n.id === before.nodes[j]!.id);
    }
    merged.splice(at + 1, 0, node);
    present.add(node.id);
  });

  const edges: SpecEdge[] = [...after.edges];
  const seen = new Set(edges.map((e) => e.id));
  for (const e of before.edges) {
    if (seen.has(e.id) || !present.has(e.source) || !present.has(e.target)) continue;
    if (marks[e.source] !== "remove" && marks[e.target] !== "remove") continue;
    edges.push(e);
    seen.add(e.id);
  }

  const graph: SpecGraph = { nodes: merged, edges };
  return { graph, layout: autoLayoutGraph(graph), marks };
}
