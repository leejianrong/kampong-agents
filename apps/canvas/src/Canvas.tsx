import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type EdgeChange,
  type NodeChange,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toolUsage, type InsertionMarker, type SpecGraph, type SpecNode } from "@kampong/spec";
import {
  EdgeInsertContext,
  InsertEdge,
  type EdgeInsertState,
  type InsertEdgeData,
} from "./InsertEdge.js";
import type { StepKind } from "./stepKinds.js";
import { STATUS_ICON, STATUS_LABEL, type NodeRunInfo } from "./runStatus.js";

// Renders the block canvas (PLAN.md affordance: "Trigger -> Tools ->
// Workflow -> Guardrails"). Node color roles map to Material Design 3
// container roles (primary/secondary/tertiary/error containers), themed
// through theme.css's `.md3-node--*` classes and the `--xy-*` custom
// properties @xyflow/react exposes for its own chrome (nodes, edges,
// controls, background grid) -- see theme.css's "Canvas nodes" section for
// the full token wiring.
//
// Labels never spill out of their node (KAM-187): a title is one line cut with an ellipsis and carries the full
// text as its tooltip, and the node's own accessible name (`ariaLabel`) is always the full name. A workflow of
// more than MINIMAP_OVER nodes gets a minimap so a long one stays navigable.

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
  /** KAM-190: what the run on screen did to each node, by node id. Only a drawn view: the spec and layout are untouched. */
  runStatus?: Record<string, NodeRunInfo>;
  /** A failed node's "See message" (KAM-190): the id of the node whose message the run panel should show. */
  onShowRunMessage?: (id: string) => void;
}

// Defined once so @xyflow/react does not see a new map on each render.
const EDGE_TYPES = { insert: InsertEdge };

const MARKER_ID = "insertion-marker";
/** A workflow with more nodes than this gets a minimap (KAM-187). */
const MINIMAP_OVER = 15;

/** A node's title: one line, cut with an ellipsis, the whole text as its tooltip (KAM-187). */
function Title({ text }: { text: string }) {
  return (
    <div className="md3-label-large md3-node__title" title={text}>
      {text}
    </div>
  );
}

/** A line of detail under a title: at most two lines, the whole text as its tooltip (KAM-187). */
function Meta({ text }: { text: string }) {
  return (
    <div className="md3-foreach__meta md3-node__meta" title={text}>
      {text}
    </div>
  );
}

/**
 * A node's run status (KAM-190): an icon and a word, never colour alone, on the node's top edge so the node does not
 * grow. A failed one carries a "See message" button that takes the run panel to the message.
 */
function RunBadge({
  nodeId,
  info,
  onShowMessage,
}: {
  nodeId: string;
  info: NodeRunInfo;
  onShowMessage?: (id: string) => void;
}) {
  const seconds =
    info.durationMs !== undefined && info.status !== "running" && info.status !== "waiting"
      ? ` ${info.durationMs < 1000 ? `${info.durationMs} ms` : `${(info.durationMs / 1000).toFixed(1)} s`}`
      : "";
  return (
    <span className="md3-node__run-wrap">
      <span
        className={`md3-node__run md3-node__run--${info.status}`}
        data-testid="node-run-status"
        data-status={info.status}
        title={info.message}
      >
        <span aria-hidden="true" className="md3-node__run-icon">
          {STATUS_ICON[info.status]}
        </span>
        {STATUS_LABEL[info.status]}
        {info.runs !== undefined && ` (${info.runs}x)`}
        {seconds}
      </span>
      {info.status === "failed" && onShowMessage && (
        <button
          type="button"
          className="md3-node__run-link nodrag nopan"
          data-testid="node-run-message"
          aria-label={`See the message for ${nodeId.replace(/^workflow:/, "")} in Test Run`}
          onClick={(e) => {
            e.stopPropagation();
            onShowMessage(nodeId);
          }}
        >
          See message
        </button>
      )}
    </span>
  );
}

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

/** The id of the node an element is in, if it is in one. */
function nodeIdOf(el: EventTarget): string | null {
  return el instanceof Element
    ? (el.closest<HTMLElement>(".react-flow__node")?.dataset.id ?? null)
    : null;
}

/** How a line's end reads aloud: the step's own name, "the trigger", the tool's name. */
function edgeEnd(node: SpecNode | undefined, fallback: string): string {
  if (!node) return fallback;
  if (node.kind === "agent") return "the trigger";
  if (node.kind === "guardrails") return "the guardrails";
  return String(node.data.name ?? node.data.step ?? fallback);
}

/** What starts a run, from the graph (KAM-184); "Manual" for a graph that predates the field. */
const triggerLabelOf = (node: SpecNode): string =>
  typeof node.data.triggerLabel === "string" ? node.data.triggerLabel : "Manual";

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
  runStatus,
  onShowRunMessage,
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
  // Sizes xyflow measured for each node. The canvas owns the nodes (controlled), so xyflow reports a measurement as a
  // change and expects it to be applied; without that the MiniMap, which draws from the nodes it is given, has no
  // size to draw (this is why an earlier try at a minimap came up blank).
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  // The focused node keeps its flash for a moment, then goes back to normal.
  const [flashed, setFlashed] = useState<{ id: string; nonce: number } | null>(null);
  useEffect(() => setFlashed(focus ?? null), [focus]);
  // Hovering or focusing a tool lights the steps that call it, and a step lights its tools (KAM-185). The pointer
  // wins over focus while it is on a node.
  const links = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      if (!map.has(a)) map.set(a, new Set());
      map.get(a)!.add(b);
    };
    for (const [tool, steps] of Object.entries(toolUsage(graph))) {
      for (const step of steps) {
        add(tool, step);
        add(step, tool);
      }
    }
    return map;
  }, [graph]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const pointed = hovered ?? focused;
  const linked = useMemo(
    () => (pointed !== null ? (links.get(pointed) ?? new Set<string>()) : new Set<string>()),
    [links, pointed],
  );
  // Stable node/edge object identity across re-renders (App.tsx re-renders
  // on unrelated state, e.g. opening a form) -- @xyflow/react is a
  // controlled component and recreating fresh node/edge objects on every
  // render (a `.map()` with no memoization) makes it redo internal
  // reconciliation work it doesn't need to.
  const nodes: Node[] = useMemo(
    () => [
      ...graph.nodes.map((node) => {
        const run = runStatus?.[node.id];
        return {
          id: node.id,
          position: layout[node.id] ?? { x: 0, y: 0 },
          data: {
            label: run ? (
              <>
                {nodeLabel(node)}
                <RunBadge
                  nodeId={node.id}
                  info={run}
                  {...(onShowRunMessage && { onShowMessage: onShowRunMessage })}
                />
              </>
            ) : (
              nodeLabel(node)
            ),
          },
          selected: selectedId === node.id,
          ...(sizes[node.id] !== undefined && { measured: sizes[node.id] }),
          ariaLabel: nodeAriaLabel(node) + (run ? `. ${STATUS_LABEL[run.status]}` : ""),
          className: `md3-node md3-node--${node.kind}${node.parent ? " md3-node--nested" : ""}${
            flashed?.id === node.id ? " md3-node--flash" : ""
          }${linked.has(node.id) ? " md3-node--linked" : ""}${
            run ? ` md3-node--run-${run.status}` : ""
          }`,
        };
      }),
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
    [graph, layout, marker, flashed, selectedId, sizes, linked, runStatus, onShowRunMessage],
  );

  const edges: Edge[] = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return graph.edges.map((edge): Edge => {
      const into = edge.target.startsWith("workflow:") ? edge.target.slice("workflow:".length) : "";
      const insertable = onInsert !== undefined && into !== "";
      // A line is named by its steps' labels, not their internal ids (KAM-185).
      const from = edgeEnd(byId.get(edge.source), edge.source);
      const to = edgeEnd(byId.get(edge.target), edge.target);
      const name = `Line from ${from} to ${to}${edge.label !== undefined ? ` (${edge.label})` : ""}`;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "insert",
        ...(edge.label !== undefined && { label: edge.label }),
        ...(insertable && { data: { before: into } satisfies InsertEdgeData }),
        ariaLabel: insertable ? `${name}. Press Enter to insert a step before ${into}.` : name,
      };
    });
  }, [graph, onInsert]);

  // Enter (or a click) on a line selects it; that opens its picker.
  const onEdgesChange = (changes: EdgeChange[]) => {
    for (const change of changes) {
      if (change.type === "select" && change.selected) setOpenEdge(change.id);
    }
  };

  // Selection is the app's: a click (or Enter or Space on a focused node) reports the node, and the app draws
  // it selected through `selectedId`. Deselecting is the app's too (Esc, Close), so a clear is ignored here.
  const onNodesChange = (changes: NodeChange[]) => {
    const measured: Record<string, { width: number; height: number }> = {};
    for (const change of changes) {
      if (change.type === "select" && change.selected && change.id !== MARKER_ID) {
        onSelect?.(change.id);
      } else if (change.type === "dimensions" && change.dimensions) {
        const { width, height } = change.dimensions;
        const had = sizes[change.id];
        if (had?.width !== width || had?.height !== height) measured[change.id] = { width, height };
      }
    }
    if (Object.keys(measured).length > 0) setSizes((prev) => ({ ...prev, ...measured }));
  };

  return (
    <div
      className="md3-flow-wrap"
      onFocus={(e) => setFocused(nodeIdOf(e.target))}
      onBlur={() => setFocused(null)}
    >
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
          onNodeMouseEnter={(_, node) => setHovered(node.id)}
          onNodeMouseLeave={() => setHovered(null)}
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
          {graph.nodes.length > MINIMAP_OVER && (
            <MiniMap
              pannable
              zoomable
              ariaLabel="Overview of the workflow. Drag to pan, scroll to zoom."
              nodeStrokeWidth={3}
            />
          )}
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
      <Title text={`Branch: ${String(node.data.step)}`} />
      <Meta text={b.if !== undefined ? `if ${b.if}` : `switch ${b.switch}`} />
      <Meta text="arms are below" />
    </div>
  );
}

function stopLabel(node: SpecNode): ReactNode {
  const stop = node.data.stop as { reason?: string; status?: string };
  return (
    <div>
      <Title text={`Stop: ${String(node.data.step)}`} />
      <Meta
        text={`ends the run as ${stop.status ?? "skipped"}${
          stop.reason !== undefined ? `: ${stop.reason}` : ""
        }`}
      />
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
      <Title text={`Foreach: ${String(node.data.step)}`} />
      <Meta
        text={`over ${loop.items} as ${loop.as} \u00b7 on_error ${policy}${
          loop.concurrency !== undefined ? ` \u00b7 concurrency ${loop.concurrency}` : ""
        }`}
      />
      <Meta
        text={`${(loop.steps ?? []).length} ${
          (loop.steps ?? []).length === 1 ? "step" : "steps"
        } inside, below`}
      />
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
  if (summary === "") return <Title text={`${kind}: ${step}`} />;
  return (
    <div>
      <Title text={`${kind}: ${step}`} />
      <Meta text={summary} />
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
      <Meta
        text={`in ${node.parent.replace(/^workflow:/, "")}${
          node.arm !== undefined ? ` \u00b7 ${node.arm}` : ""
        }`}
      />
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
  if (node.kind === "agent") what = `Trigger, ${triggerLabelOf(node)}`;
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
    if (node.data.type === "tool") return <Title text={`Tool step: ${step}`} />;
    if (node.data.type === "approval") return <Title text={`Approval: ${step}`} />;
    if (node.data.type === "transform") return dataLabel("Transform", step, transformSummary(node));
    if (node.data.type === "validate") return dataLabel("Validate", step, validateSummary(node));
    if (node.data.type === "dedupe") return dataLabel("Dedupe", step, dedupeSummary(node));
    return <Title text={`Workflow: ${step}`} />;
  }
  if (node.kind === "agent") return <Title text={triggerLabelOf(node)} />;
  const kind = KIND_LABEL[node.kind];
  const name = String(node.data.name ?? node.data.step ?? node.id);
  return <Title text={`${kind}: ${name}`} />;
}
