import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { SpecGraph, SpecNode } from "@kampong/spec";

// Renders the block canvas (PLAN.md affordance: "Trigger -> Tools ->
// Workflow -> Guardrails"). Node color roles are named after Material
// Design 3 container roles (primary/secondary/tertiary/error containers) as
// a minimal starting point -- a full MD3 pass (elevation, state layers,
// the generated palette) is follow-up work, not this slice's scope.

export interface CanvasProps {
  graph: SpecGraph;
  layout: Record<string, { x: number; y: number }>;
}

const KIND_LABEL: Record<SpecNode["kind"], string> = {
  agent: "Trigger",
  tool: "Tool",
  workflow: "Workflow",
  guardrails: "Guardrails",
};

export function Canvas({ graph, layout }: CanvasProps) {
  const nodes: Node[] = graph.nodes.map((node) => ({
    id: node.id,
    position: layout[node.id] ?? { x: 0, y: 0 },
    data: { label: nodeLabel(node) },
  }));

  const edges: Edge[] = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
  }));

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow nodes={nodes} edges={edges} fitView />
    </div>
  );
}

function nodeLabel(node: SpecNode): string {
  const kind = KIND_LABEL[node.kind];
  const name = String(node.data.name ?? node.data.step ?? node.id);
  return `${kind}: ${name}`;
}
