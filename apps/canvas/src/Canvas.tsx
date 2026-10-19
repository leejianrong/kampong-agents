import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { InsertionMarker, SpecGraph, SpecNode } from "@kampong/spec";

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
  /** Where the step being added will land (KAM-173): drawn as a dashed placeholder beside a node. */
  marker?: InsertionMarker;
  /** A node to pan into view and flash, as after an add (KAM-173). A new `nonce` repeats it. */
  focus?: { id: string; nonce: number };
}

const MARKER_ID = "insertion-marker";
const FLASH_MS = 2200;

/** Pans to the focused node once it is on the canvas, and flashes it. Rendered inside <ReactFlow>. */
function FocusNode({
  focus,
  onDone,
}: {
  focus: { id: string; nonce: number };
  onDone: () => void;
}) {
  const flow = useReactFlow();
  useEffect(() => {
    let tries = 0;
    const go = () => {
      if (!flow.getNode(focus.id)) {
        // The graph refreshes after the save; wait for the node to arrive.
        if (tries++ < 20) timer = setTimeout(go, 100);
        return;
      }
      void flow.fitView({ nodes: [{ id: focus.id }], duration: 400, maxZoom: 1.2, padding: 0.6 });
    };
    let timer = setTimeout(go, 0);
    const done = setTimeout(onDone, FLASH_MS);
    return () => {
      clearTimeout(timer);
      clearTimeout(done);
    };
  }, [flow, focus.id, focus.nonce, onDone]);
  return null;
}

const KIND_LABEL: Record<SpecNode["kind"], string> = {
  agent: "Trigger",
  tool: "Tool",
  workflow: "Workflow",
  guardrails: "Guardrails",
};

export function Canvas({ graph, layout, marker, focus }: CanvasProps) {
  // The focused node keeps its flash for a moment, then goes back to normal.
  const [flashed, setFlashed] = useState<{ id: string; nonce: number } | null>(null);
  useEffect(() => setFlashed(focus ?? null), [focus]);
  // Stable node/edge object identity across re-renders (App.tsx re-renders
  // on unrelated state, e.g. opening a form) -- @xyflow/react is a
  // controlled component and recreating fresh node/edge objects on every
  // render (a `.map()` with no memoization) makes it redo internal
  // reconciliation work it doesn't need to.
  const nodes: Node[] = useMemo(
    () => [
      ...graph.nodes.map((node) => ({
        id: node.id,
        position: layout[node.id] ?? { x: 0, y: 0 },
        data: { label: nodeLabel(node) },
        className: `md3-node md3-node--${node.kind}${node.parent ? " md3-node--nested" : ""}${
          flashed?.id === node.id ? " md3-node--flash" : ""
        }`,
      })),
      ...(marker
        ? [
            {
              id: MARKER_ID,
              position: {
                x: (layout[marker.anchor] ?? { x: 0, y: 0 }).x,
                y:
                  (layout[marker.anchor] ?? { x: 0, y: 0 }).y +
                  (marker.side === "above" ? -48 : 70),
              },
              data: { label: marker.label },
              className: "md3-node md3-node--marker",
              draggable: false,
              selectable: false,
              connectable: false,
            },
          ]
        : []),
    ],
    [graph, layout, marker, flashed],
  );

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.label !== undefined && { label: edge.label }),
      })),
    [graph],
  );

  return (
    <div className="md3-flow-wrap">
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls />
        {focus && flashed && <FocusNode focus={focus} onDone={() => setFlashed(null)} />}
      </ReactFlow>
    </div>
  );
}

function branchLabel(node: SpecNode): ReactNode {
  const b = node.data.branch as { if?: string; switch?: string };
  return (
    <div className="md3-foreach">
      <div className="md3-label-large">Branch: {String(node.data.step)}</div>
      <div className="md3-foreach__meta">
        {b.if !== undefined ? `if ${b.if}` : `switch ${b.switch}`}
      </div>
      <div className="md3-foreach__meta">its arms are the steps below, labelled on the lines</div>
    </div>
  );
}

function stopLabel(node: SpecNode): ReactNode {
  const stop = node.data.stop as { reason?: string; status?: string };
  return (
    <div>
      <div className="md3-label-large">Stop: {String(node.data.step)}</div>
      <div className="md3-foreach__meta">
        ends the run as {stop.status ?? "skipped"}
        {stop.reason !== undefined && <>: {stop.reason}</>}
      </div>
    </div>
  );
}

function foreachLabel(node: SpecNode): ReactNode {
  const loop = node.data.foreach as {
    items: string;
    as: string;
    concurrency?: number;
    on_error?: string | { retry?: { n: number } };
    steps?: unknown[];
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
      <div className="md3-foreach__meta">
        {(loop.steps ?? []).length} {(loop.steps ?? []).length === 1 ? "step" : "steps"} inside,
        below
      </div>
    </div>
  );
}

// What a data step does, in a line under its title (KAM-152). Long expressions are cut so a node stays small.
const clip = (text: string, n = 48) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

function transformSummary(node: SpecNode): string {
  const names = Object.keys((node.data.set as Record<string, string> | undefined) ?? {});
  return names.length === 0 ? "" : clip(`sets ${names.join(", ")}`);
}
function validateSummary(node: SpecNode): string {
  const on = node.data.on_fail === "skip" ? "skip" : "fail";
  return `${clip(`asserts ${String(node.data.assert ?? "")}`)} · on fail ${on}`;
}
function dedupeSummary(node: SpecNode): string {
  const once = (node.data.once ?? {}) as { key?: string; ttl?: string };
  return clip(`once per ${once.key ?? "?"} for ${once.ttl ?? "?"}`);
}

function dataLabel(kind: string, step: string, summary: string): ReactNode {
  if (summary === "") return `${kind}: ${step}`;
  return (
    <div>
      <div className="md3-label-large">
        {kind}: {step}
      </div>
      <div className="md3-foreach__meta">{summary}</div>
    </div>
  );
}

function nodeLabel(node: SpecNode): ReactNode {
  const label = ownLabel(node);
  if (!node.parent) return label;
  // A foreach body step says which loop it is in, so the grouping reads even when the nodes are dragged apart.
  return (
    <div>
      <div>{label}</div>
      <div className="md3-foreach__meta">
        in {node.parent.replace(/^workflow:/, "")}
        {node.arm !== undefined && <> &middot; {node.arm}</>}
      </div>
    </div>
  );
}

function ownLabel(node: SpecNode): ReactNode {
  // Workflow nodes read their step kind from the data so the new first-class
  // tool/approval steps (KAN-1429) are distinguishable on the canvas; action
  // and condition steps keep the existing "Workflow: <step>" label.
  if (node.kind === "workflow") {
    if (node.data.foreach) return foreachLabel(node);
    if (node.data.branch) return branchLabel(node);
    if (node.data.stop) return stopLabel(node);
    const step = String(node.data.step ?? node.id);
    if (node.data.type === "tool") return `Tool step: ${step}`;
    if (node.data.type === "approval") return `Approval: ${step}`;
    if (node.data.type === "transform") return dataLabel("Transform", step, transformSummary(node));
    if (node.data.type === "validate") return dataLabel("Validate", step, validateSummary(node));
    if (node.data.type === "dedupe") return dataLabel("Dedupe", step, dedupeSummary(node));
    return `Workflow: ${step}`;
  }
  const kind = KIND_LABEL[node.kind];
  const name = String(node.data.name ?? node.data.step ?? node.id);
  return `${kind}: ${name}`;
}
