import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import type { SpecGraph, SpecNode } from "@kampong/spec";

// Renders the block canvas (PLAN.md affordance: "Trigger -> Tools ->
// Workflow -> Guardrails"). Node color roles map to Material Design 3
// container roles (primary/secondary/tertiary/error containers), themed
// through theme.css's `.md3-node--*` classes and the `--xy-*` custom
// properties @xyflow/react exposes for its own chrome (nodes, edges,
// controls, background grid) -- see theme.css's "Canvas nodes" section for
// the full token wiring.
//
// No <MiniMap>: tried it during this pass (feat/canvas-md3-pass) and its
// node rects never rendered against this spec's graph (verified via
// Playwright -- .react-flow__minimap-node count stayed 0 even after a
// pan/zoom interaction and after memoizing nodes/edges below), while
// fitView's bounding box and every on-canvas node measured correctly. That
// points at a measured-dimensions gap in @xyflow/react's MiniMap-specific
// store subscription (12.11.6), not a styling issue -- shipping a visibly
// blank minimap widget would be worse than leaving it out. Background +
// Controls both render and theme correctly on their own.

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
  // Stable node/edge object identity across re-renders (App.tsx re-renders
  // on unrelated state, e.g. opening a form) -- @xyflow/react is a
  // controlled component and recreating fresh node/edge objects on every
  // render (a `.map()` with no memoization) makes it redo internal
  // reconciliation work it doesn't need to.
  const nodes: Node[] = useMemo(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        position: layout[node.id] ?? { x: 0, y: 0 },
        data: { label: nodeLabel(node) },
        className: `md3-node md3-node--${node.kind}`,
      })),
    [graph, layout],
  );

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })),
    [graph],
  );

  return (
    <div className="md3-flow-wrap">
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function nodeLabel(node: SpecNode): string {
  const kind = KIND_LABEL[node.kind];
  const name = String(node.data.name ?? node.data.step ?? node.id);
  return `${kind}: ${name}`;
}
