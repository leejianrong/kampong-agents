import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, type ReactNode } from "react";
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
  const positions = useMemo(() => withNestedRoom(graph, layout), [graph, layout]);
  const nodes: Node[] = useMemo(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        data: { label: nodeLabel(node) },
        className: `md3-node md3-node--${node.kind}`,
      })),
    [graph, positions],
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

// A foreach node lists its nested steps, so it is taller than the 120px a row of the auto layout allows. The
// nodes below it in the same column are moved down for display only; the sidecar layout is not touched.
const NESTED_STEP_HEIGHT = 22;

function nestedSteps(node: SpecNode): { step: string; type?: string }[] {
  const foreach = node.data.foreach as { steps?: { step: string; type?: string }[] } | undefined;
  return foreach?.steps ?? [];
}

function withNestedRoom(
  graph: SpecGraph,
  layout: Record<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const column = new Map<number, SpecNode[]>();
  for (const node of graph.nodes) {
    positions.set(node.id, layout[node.id] ?? { x: 0, y: 0 });
    column.set(node.column, [...(column.get(node.column) ?? []), node]);
  }
  for (const nodes of column.values()) {
    let extra = 0;
    for (const node of [...nodes].sort((a, b) => positions.get(a.id)!.y - positions.get(b.id)!.y)) {
      const at = positions.get(node.id)!;
      positions.set(node.id, { x: at.x, y: at.y + extra });
      extra += nestedSteps(node).length * NESTED_STEP_HEIGHT;
    }
  }
  return positions;
}

const STEP_LABEL: Record<string, string> = {
  tool: "Tool step",
  approval: "Approval",
  transform: "Transform",
  validate: "Validate",
  dedupe: "Dedupe",
};

function foreachLabel(node: SpecNode): ReactNode {
  const loop = node.data.foreach as {
    items: string;
    as: string;
    concurrency?: number;
    on_error?: string | { retry?: { n: number } };
  };
  const policy =
    typeof loop.on_error === "object" && loop.on_error?.retry
      ? `retry ${loop.on_error.retry.n}`
      : String(loop.on_error ?? "fail");
  return (
    <div className="md3-foreach">
      <div className="md3-label-large">Foreach: {String(node.data.step)}</div>
      <div className="md3-foreach__meta">
        over {loop.items} as {loop.as} &middot; on_error {policy}
        {loop.concurrency !== undefined && <> &middot; concurrency {loop.concurrency}</>}
      </div>
      <ol className="md3-foreach__steps">
        {nestedSteps(node).map((inner) => (
          <li key={inner.step}>
            {inner.type === "condition" ? "Workflow" : (STEP_LABEL[inner.type ?? ""] ?? "Workflow")}
            : {inner.step}
          </li>
        ))}
      </ol>
    </div>
  );
}

function nodeLabel(node: SpecNode): ReactNode {
  // Workflow nodes read their step kind from the data so the new first-class
  // tool/approval steps (KAN-1429) are distinguishable on the canvas; action
  // and condition steps keep the existing "Workflow: <step>" label.
  if (node.kind === "workflow") {
    if (node.data.foreach) return foreachLabel(node);
    const step = String(node.data.step ?? node.id);
    if (node.data.type === "tool") return `Tool step: ${step}`;
    if (node.data.type === "approval") return `Approval: ${step}`;
    if (node.data.type === "transform") return `Transform: ${step}`;
    if (node.data.type === "validate") return `Validate: ${step}`;
    if (node.data.type === "dedupe") return `Dedupe: ${step}`;
    return `Workflow: ${step}`;
  }
  const kind = KIND_LABEL[node.kind];
  const name = String(node.data.name ?? node.data.step ?? node.id);
  return `${kind}: ${name}`;
}
