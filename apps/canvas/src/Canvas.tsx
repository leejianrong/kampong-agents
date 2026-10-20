import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useReactFlow,
  type EdgeChange,
  type NodeChange,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { InsertionMarker, SpecGraph, SpecNode } from "@kampong/spec";
import {
  EdgeInsertContext,
  InsertEdge,
  type EdgeInsertState,
  type InsertEdgeData,
} from "./InsertEdge.js";
import type { StepKind } from "./stepKinds.js";

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
  /** The selected node's id (KAM-211): drawn with the selected outline. */
  selectedId?: string | null;
  /** A node was clicked, or chosen with Enter or Space while focused. */
  onSelect?: (id: string) => void;
  /** The empty canvas was clicked. */
  onPaneClick?: () => void;
  /**
   * A "+" on a line (KAM-213): the id of the edge and the kind chosen from its picker. Without it the lines have
   * no "+". `version` is the spec's, for which kinds the picker offers.
   */
  onInsert?: (edgeId: string, kind: StepKind) => void;
  version?: string;
}

// Defined once so @xyflow/react does not see a new map on each render.
const EDGE_TYPES = { insert: InsertEdge };

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

export function Canvas({
  graph,
  layout,
  marker,
  focus,
  selectedId,
  onSelect,
  onPaneClick,
  onInsert,
  version,
}: CanvasProps) {
  const [openEdge, setOpenEdge] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  // The pointer crosses a gap between the line and its "+": a short delay keeps the "+" from blinking out.
  const hover = useCallback((id: string | null) => {
    clearTimeout(hoverTimer.current);
    if (id !== null) setHoverEdge(id);
    else hoverTimer.current = setTimeout(() => setHoverEdge(null), 150);
  }, []);
  const insertState = useMemo<EdgeInsertState>(
    () => ({
      ...(version !== undefined && { version }),
      hoverId: hoverEdge,
      hover,
      openId: openEdge,
      open: setOpenEdge,
      close: (restoreFocus) => {
        const id = openEdge;
        setOpenEdge(null);
        if (restoreFocus && id !== null) {
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLElement>(`.react-flow__edge[data-id="${CSS.escape(id)}"]`)
              ?.focus(),
          );
        }
      },
      choose: (id, kind) => {
        setOpenEdge(null);
        onInsert?.(id, kind);
      },
    }),
    [version, hoverEdge, hover, openEdge, onInsert],
  );
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
        selected: selectedId === node.id,
        ariaLabel: nodeAriaLabel(node),
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
    [graph, layout, marker, flashed, selectedId],
  );

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((edge): Edge => {
        const into = edge.target.startsWith("workflow:")
          ? edge.target.slice("workflow:".length)
          : "";
        const insertable = onInsert !== undefined && into !== "";
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          ...(edge.label !== undefined && { label: edge.label }),
          ...(insertable && {
            type: "insert",
            data: { before: into } satisfies InsertEdgeData,
            ariaLabel: `Line into ${into}. Press Enter to insert a step before it.`,
          }),
        };
      }),
    [graph, onInsert],
  );

  // Enter (or a click) on a line selects it; that opens its picker.
  const onEdgesChange = (changes: EdgeChange[]) => {
    for (const change of changes) {
      if (change.type === "select" && change.selected) setOpenEdge(change.id);
    }
  };

  // Selection is the app's: a click (or Enter or Space on a focused node) reports the node, and the app draws
  // it selected through `selectedId`. Deselecting is the app's too (Esc, Close), so a clear is ignored here.
  const onNodesChange = (changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === "select" && change.selected && change.id !== MARKER_ID) {
        onSelect?.(change.id);
      }
    }
  };

  return (
    <div className="md3-flow-wrap">
      <EdgeInsertContext.Provider value={insertState}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          edgeTypes={EDGE_TYPES}
          fitView
          minZoom={0.1}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onEdgeMouseEnter={(_, edge) => hover(edge.id)}
          onEdgeMouseLeave={() => hover(null)}
          onMoveStart={() => setOpenEdge(null)}
          onNodeClick={(_, node) => {
            setOpenEdge(null);
            if (node.id !== MARKER_ID) onSelect?.(node.id);
          }}
          onPaneClick={() => {
            setOpenEdge(null);
            onPaneClick?.();
          }}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls />
          {focus && flashed && <FocusNode focus={focus} onDone={() => setFlashed(null)} />}
        </ReactFlow>
      </EdgeInsertContext.Provider>
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

const STEP_KIND_WORD: Record<string, string> = {
  tool: "Tool",
  approval: "Approval",
  transform: "Transform",
  validate: "Validate",
  dedupe: "Dedupe",
};

/** What a screen reader hears for a node: its kind and name, and where a nested step sits. */
function nodeAriaLabel(node: SpecNode): string {
  const name = String(node.data.name ?? node.data.step ?? node.id);
  let what: string;
  if (node.kind === "agent") what = "Trigger";
  else if (node.kind === "tool") what = `Tool ${name}`;
  else if (node.kind === "guardrails") what = "Guardrails";
  else {
    const d = node.data;
    const kind = d.foreach
      ? "Foreach"
      : d.branch
        ? "Branch"
        : d.stop
          ? "Stop"
          : (STEP_KIND_WORD[String(d.type)] ?? "Workflow");
    what = `${kind} step ${name}`;
  }
  if (node.parent) {
    const arm = node.arm !== undefined ? `, ${node.arm}` : "";
    what += `, in ${node.parent.replace(/^workflow:/, "")}${arm}`;
  }
  return what;
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
