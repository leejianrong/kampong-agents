import {
  Background,
  BackgroundVariant,
  Position,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  useUpdateNodeInternals,
  type EdgeChange,
  type NodeChange,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CardToolbar } from "./CardToolbar.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  toolUsage,
  type ComponentBrand,
  type InsertionMarker,
  type PreviewMark,
  type SpecGraph,
  type SpecNode,
} from "@kampong/spec";
import {
  EdgeInsertContext,
  InsertEdge,
  type EdgeInsertState,
  type InsertEdgeData,
} from "./InsertEdge.js";
import type { StepKind } from "./stepKinds.js";
import { NodeCard } from "./nodeCard.js";
import { connectorBrands } from "./connectorBrand.js";
import { ToolLinkEdge } from "./ToolLinkEdge.js";
import { edgeRun, edgeRunText } from "./edgeRun.js";
import { CollapsedLoop, LoopGroupNode, type LoopGroupData } from "./loopGroupNode.js";
import {
  applyCollapse,
  collapsedByDefault,
  groupBox,
  groupsAround,
  isGroupId,
  loopGroups,
  type LoopGroup,
} from "./loopGroups.js";
import { dragOutcome } from "./nodeDrag.js";
import { STATUS_ICON, pillText, reasonLine, type NodeRunInfo } from "./runStatus.js";

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

/** What the card toolbar can ask for (KAM-245). */
export type NodeAction = "duplicate" | "delete";

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
  /** Brands of the installed components by `id@version` (KAM-247); a component without one gets its initial. */
  brands?: Record<string, ComponentBrand>;
  /** Nodes the assistant's last Apply added (KAM-250): each wears a "New" mark. */
  markedNew?: string[];
  /** The plan on show (KAM-206): what it adds, changes and removes, by node id. The graph passed in is the preview. */
  marks?: Record<string, PreviewMark>;
  /** The selected step or tool's floating toolbar (KAM-245): Duplicate or Delete. Without it there is no toolbar. */
  onNodeAction?: (action: NodeAction, id: string) => void;
  /** KAM-186 (ADR-0061): a card was dragged onto empty canvas; save it there. `position` is in the stored layout's coordinates. Resolves once saved. Without it cards are not draggable. */
  onNodeMove?: (id: string, position: { x: number; y: number }) => Promise<void>;
  /** KAM-186: a step was dropped on another step of its list; move it to that step's place in the run order. Resolves once done or refused. */
  onNodeReorder?: (id: string, overId: string) => Promise<void>;
  /** A failed node's "See message" (KAM-190): the id of the node whose message the run panel should show. */
  onShowRunMessage?: (id: string) => void;
}

// Defined once so @xyflow/react does not see a new map on each render.
const EDGE_TYPES = { insert: InsertEdge, toolLink: ToolLinkEdge };
const NODE_TYPES = { loopGroup: LoopGroupNode };

const MARKER_ID = "insertion-marker";
/**
 * KAM-238: a long workflow opens on its first steps at a size you can read, not the whole of it at a quarter
 * zoom. Up to this many steps in run order are fitted; a shorter one is fitted whole.
 */
const FIT_HEAD = 4;
const MIN_READABLE_ZOOM = 0.8;
/** A workflow with more nodes than this gets a minimap (KAM-187). */
const MINIMAP_OVER = 15;

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
        {pillText(info)}
        {info.runs !== undefined && ` (${info.runs}x)`}
        {seconds}
      </span>
      {info.status === "failed" && onShowMessage && (
        <button
          type="button"
          className="md3-node__run-link nodrag nopan"
          data-testid="node-run-message"
          aria-label={`See message for ${nodeId.replace(/^workflow:/, "")} in Test Run`}
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

/**
 * The canvas owns the nodes, so it hands React Flow each node's measured size back (`measured`). React Flow drops a
 * node's port positions whenever that size differs from the one it has, and re-measures them only when the element
 * resizes; if the two already agree, nothing resizes and the node is left with no ports, so no line to or from it is
 * drawn. Asking for a re-measure after the sizes change closes that gap. Rendered inside <ReactFlow>.
 */
function KeepPortsMeasured({ sizes }: { sizes: Record<string, unknown> }) {
  const update = useUpdateNodeInternals();
  useEffect(() => {
    // A DOM with no layout (a unit test's) has nothing to measure, and React Flow's re-measure needs DOMMatrix.
    if (typeof window.DOMMatrixReadOnly === "undefined") return;
    const frame = requestAnimationFrame(() => update(Object.keys(sizes)));
    return () => cancelAnimationFrame(frame);
  }, [sizes, update]);
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
  if (!node) return isGroupId(fallback) ? "the collapsed loop" : fallback;
  if (node.kind === "agent") return "the trigger";
  if (node.kind === "guardrails") return "the guardrails";
  return String(node.data.name ?? node.data.step ?? fallback);
}

/** What starts a run, from the graph (KAM-184); "Manual" for a graph that predates the field. */
const triggerLabelOf = (node: SpecNode): string =>
  typeof node.data.triggerLabel === "string" ? node.data.triggerLabel : "Manual";

// KAM-200: the nodes are Tab stops in the order they are given to React Flow. The graph lists the tools right after the
// trigger, but a person reads and runs trigger, steps in order, then the things the steps call and the limits, so
// that is the order Tab takes. A stable sort by kind keeps each kind's own order.
const TAB_RANK: Record<string, number> = { agent: 0, workflow: 1, tool: 2, guardrails: 3 };

function inTabOrder<T extends { kind: string }>(nodes: readonly T[]): T[] {
  return [...nodes].sort((a, b) => (TAB_RANK[a.kind] ?? 4) - (TAB_RANK[b.kind] ?? 4));
}

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
  onNodeAction,
  onNodeMove,
  onNodeReorder,
  brands,
  markedNew,
  marks,
}: CanvasProps) {
  const [openEdge, setOpenEdge] = useState<string | null>(null);
  // KAM-239: loops the person has opened or closed, by the foreach step's node id; the rest follow their default.
  const groups = useMemo(() => loopGroups(graph), [graph]);
  const [shutBy, setShutBy] = useState<Record<string, boolean>>({});
  const isShut = useCallback((g: LoopGroup) => shutBy[g.holder] ?? collapsedByDefault(g), [shutBy]);
  const toggleLoop = useCallback(
    (holder: string) =>
      setShutBy((prev) => {
        const g = groups.find((o) => o.holder === holder);
        const now = prev[holder] ?? (g !== undefined && collapsedByDefault(g));
        return { ...prev, [holder]: !now };
      }),
    [groups],
  );
  // A collapsed card's click and its Enter both arrive as a selection, and a click as a click too, so opening it
  // is a set, not a flip.
  const expandLoop = useCallback(
    (holder: string) => setShutBy((prev) => ({ ...prev, [holder]: false })),
    [],
  );
  // A step that is selected, focused or about to get a neighbour is never left hidden inside a closed loop.
  const reveal = [selectedId, focus?.id, marker?.anchor].join("|");
  useEffect(() => {
    const wanted = [selectedId, focus?.id, marker?.anchor].flatMap((id) =>
      id ? groupsAround(groups, id) : [],
    );
    const hidden = wanted.filter((g) => isShut(g));
    if (hidden.length > 0) {
      setShutBy((prev) => ({
        ...prev,
        ...Object.fromEntries(hidden.map((g) => [g.holder, false])),
      }));
    }
  }, [reveal, groups]);
  // KAM-186: where a card being dragged is, until the app has saved the drop and handed back a new layout.
  const [dragPos, setDragPos] = useState<Record<string, { x: number; y: number }>>({});
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
  const view = useMemo(
    () => applyCollapse(graph, layout, groups, isShut),
    [graph, layout, groups, isShut],
  );
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
  const flowWrap = useRef<HTMLDivElement>(null);

  // KAM-200: Tab goes from the toolbar to the nodes in the order a run goes through them, not through every line first.
  // React Flow makes each line a Tab stop and has no setting for "focusable, but not in the Tab order", so the lines are
  // moved to tabindex -1 as they appear: a click, or a script, still focuses one and Enter on it still opens its picker,
  // and a keyboard user adds a step at any place from the Add step form's Position choice.
  useEffect(() => {
    const root = flowWrap.current;
    if (!root) return;
    const demote = () => {
      for (const line of root.querySelectorAll('.react-flow__edge[tabindex="0"]')) {
        line.setAttribute("tabindex", "-1");
      }
    };
    demote();
    const observer = new MutationObserver(demote);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
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
  const fitViewOptions = useMemo(() => {
    const run = view.graph.nodes.filter((n) => n.kind === "agent" || n.kind === "workflow");
    return {
      padding: 0.15,
      minZoom: MIN_READABLE_ZOOM,
      maxZoom: 1,
      ...(run.length > FIT_HEAD && { nodes: run.slice(0, FIT_HEAD).map((n) => ({ id: n.id })) }),
    };
  }, [view]);
  const outlineOf = (g: LoopGroup): Node[] => {
    const box = groupBox(g, view.layout, sizes);
    if (box === undefined) return [];
    return [
      {
        id: `outline:${g.holder}`,
        type: "loopGroup",
        position: { x: box.x, y: box.y },
        width: box.width,
        height: box.height,
        measured: { width: box.width, height: box.height },
        data: {
          label: g.label,
          steps: g.members.length,
          onToggle: () => toggleLoop(g.holder),
        } satisfies LoopGroupData,
        zIndex: -1,
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
        ariaLabel: `Loop ${g.label}, ${g.members.length} steps`,
      },
    ];
  };
  const tiles = useMemo(() => connectorBrands(graph, brands), [graph, brands]);
  const fresh = useMemo(() => new Set(markedNew ?? []), [markedNew]);
  const nodes: Node[] = useMemo(
    () => [
      ...inTabOrder(view.graph.nodes).flatMap((node) => {
        const run = runStatus?.[node.id];
        const toolbar =
          onNodeAction !== undefined &&
          selectedId === node.id &&
          (node.kind === "workflow" || node.kind === "tool") ? (
            <CardToolbar
              what={`${node.kind === "tool" ? "tool" : "step"} ${String(node.data.step ?? node.data.name ?? node.id)}`}
              onAction={(action) => onNodeAction(action, node.id)}
            />
          ) : null;
        const card: Node = {
          id: node.id,
          position: view.layout[node.id] ?? { x: 0, y: 0 },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            label: run ? (
              <>
                {toolbar}
                <NodeCard
                  node={node}
                  brand={tiles[node.id]}
                  isNew={fresh.has(node.id)}
                  mark={marks?.[node.id]}
                  {...(run.status === "failed" && { reason: reasonLine(run.message) })}
                />
                <RunBadge
                  nodeId={node.id}
                  info={run}
                  {...(onShowRunMessage && { onShowMessage: onShowRunMessage })}
                />
              </>
            ) : (
              <>
                {toolbar}
                <NodeCard
                  node={node}
                  brand={tiles[node.id]}
                  isNew={fresh.has(node.id)}
                  mark={marks?.[node.id]}
                />
              </>
            ),
          },
          selected: selectedId === node.id,
          ...(sizes[node.id] !== undefined && { measured: sizes[node.id] }),
          ariaLabel:
            nodeAriaLabel(node) +
            (marks?.[node.id] ? `. The plan would ${marks[node.id]} this` : "") +
            (run
              ? `. ${pillText(run)}${run.status === "failed" && reasonLine(run.message) ? `: ${reasonLine(run.message)}` : ""}`
              : ""),
          className: `md3-node md3-node--${node.kind}${node.parent ? " md3-node--nested" : ""}${
            marks?.[node.id] ? ` md3-node--preview-${marks[node.id]}` : ""
          }${
            flashed?.id === node.id ? " md3-node--flash" : ""
          }${linked.has(node.id) ? " md3-node--linked" : ""}${
            run ? ` md3-node--run-${run.status}` : ""
          }`,
        };
        // An open loop's outline follows its step in the Tab order, so its collapse button comes next.
        const outline = view.open.filter((g) => g.holder === node.id).flatMap(outlineOf);
        return [card, ...outline];
      }),
      ...view.collapsed.map(({ group, position }): Node => ({
        id: group.id,
        position,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        data: { label: <CollapsedLoop label={group.label} steps={group.members.length} /> },
        selectable: true,
        draggable: false,
        ...(sizes[group.id] !== undefined && { measured: sizes[group.id] }),
        ariaLabel: `Loop ${group.label}, collapsed, ${group.members.length} steps. Press Enter to expand.`,
        className: "md3-node md3-node--flow md3-node--collapsed-loop",
      })),
      ...(marker
        ? [
            {
              id: MARKER_ID,
              position: {
                x: (layout[marker.anchor] ?? { x: 0, y: 0 }).x,
                y:
                  (layout[marker.anchor] ?? { x: 0, y: 0 }).y +
                  (marker.side === "above" ? -52 : 104),
              },
              data: { label: marker.label },
              sourcePosition: Position.Right,
              targetPosition: Position.Left,
              className: "md3-node md3-node--marker",
              draggable: false,
              selectable: false,
              connectable: false,
            },
          ]
        : []),
    ],
    [
      view,
      layout,
      marker,
      flashed,
      selectedId,
      sizes,
      linked,
      runStatus,
      onShowRunMessage,
      onNodeAction,
      tiles,
      fresh,
      marks,
    ],
  );

  // KAM-186: a card being dragged follows the pointer here, after the big memo above, so a mouse move touches only
  // the dragged card (and the outlines of loops it belongs to); every other node keeps its object identity and its
  // card element, and the edges do not depend on the drag at all.
  const shownNodes: Node[] = useMemo(() => {
    const dragged = Object.keys(dragPos);
    if (dragged.length === 0) return nodes;
    const at = { ...view.layout, ...dragPos };
    return nodes.map((n) => {
      if (dragPos[n.id] !== undefined) return { ...n, position: dragPos[n.id]! };
      if (n.id.startsWith("outline:")) {
        const g = groups.find((o) => `outline:${o.holder}` === n.id);
        if (g && g.members.some((m) => dragPos[m] !== undefined)) {
          const box = groupBox(g, at, sizes);
          if (box) {
            return {
              ...n,
              position: { x: box.x, y: box.y },
              width: box.width,
              height: box.height,
              measured: { width: box.width, height: box.height },
            };
          }
        }
      }
      return n;
    });
  }, [nodes, dragPos, view, groups, sizes]);

  const edges: Edge[] = useMemo(() => {
    const byId = new Map(view.graph.nodes.map((n) => [n.id, n]));
    // The node whose run result a line shows: the step it leads into (a collapsed loop's first step).
    const resultOf = (id: string): NodeRunInfo | undefined => {
      const group = view.collapsed.find((c) => c.group.id === id);
      return runStatus?.[group ? group.group.members[0]! : id];
    };
    const runLines = view.graph.edges.map((edge): Edge => {
      const into = edge.target.startsWith("workflow:") ? edge.target.slice("workflow:".length) : "";
      const insertable = onInsert !== undefined && into !== "";
      // A line is named by its steps' labels, not their internal ids (KAM-185).
      const from = edgeEnd(byId.get(edge.source), edge.source);
      const to = edgeEnd(byId.get(edge.target), edge.target);
      const run = edgeRun(resultOf(edge.target));
      // An arm with no steps (or a missing else/default) runs on to the step after the branch: a dashed carry-on.
      const carryOn =
        edge.label !== undefined &&
        byId.get(edge.source)?.data.branch !== undefined &&
        byId.get(edge.target)?.parent !== edge.source;
      const said = run ? `. ${edgeRunText(run)}` : "";
      const name = `Line from ${from} to ${to}${edge.label !== undefined ? ` (${edge.label})` : ""}${said}`;
      const data: InsertEdgeData = {
        ...(insertable && { before: into }),
        ...(run && { run }),
      };
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "insert",
        ...(run && {
          className: `kg-edge kg-edge--${run.state}`,
          animated: run.state === "running",
        }),
        ...(carryOn && {
          className: `${run ? `kg-edge kg-edge--${run.state} ` : ""}kg-edge--carry`,
        }),
        ...(edge.label !== undefined && { label: edge.label }),
        ...(Object.keys(data).length > 0 && { data }),
        ariaLabel: insertable ? `${name}. Press Enter to insert a step before ${into}.` : name,
      };
    });
    // A tool a step uses hangs off the step by a dashed line. A step inside a collapsed loop links from its card.
    const shown = new Set(view.graph.nodes.map((n) => n.id));
    const seen = new Set<string>();
    const toolLines: Edge[] = [];
    for (const [tool, steps] of Object.entries(toolUsage(graph))) {
      for (const step of steps) {
        const holder = shown.has(step)
          ? step
          : view.collapsed.find((c) => c.group.members.includes(step))?.group.id;
        if (holder === undefined || !shown.has(tool) || seen.has(`${holder}|${tool}`)) continue;
        seen.add(`${holder}|${tool}`);
        toolLines.push({
          id: `link:${holder}->${tool}`,
          source: holder,
          target: tool,
          type: "toolLink",
          className: "kg-edge kg-edge--tool",
          selectable: false,
          focusable: false,
          ariaLabel: `Tool link from ${edgeEnd(byId.get(holder), holder)} to ${edgeEnd(byId.get(tool), tool)}`,
        });
      }
    }
    return [...runLines, ...toolLines];
  }, [view, onInsert, runStatus, graph]);

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
      if (change.type === "select" && change.selected && isGroupId(change.id)) {
        expandLoop(change.id.slice("group:".length));
      } else if (change.type === "select" && change.selected && change.id !== MARKER_ID) {
        onSelect?.(change.id);
      } else if (change.type === "position" && change.position && !isGroupId(change.id)) {
        // The canvas owns the nodes, so a drag only moves a card if the position it reports is drawn.
        const at = change.position;
        setDragPos((prev) => ({ ...prev, [change.id]: at }));
      } else if (change.type === "dimensions" && change.dimensions) {
        const { width, height } = change.dimensions;
        const had = sizes[change.id];
        if (had?.width !== width || had?.height !== height) measured[change.id] = { width, height };
      }
    }
    if (Object.keys(measured).length > 0) setSizes((prev) => ({ ...prev, ...measured }));
  };

  // KAM-186 (ADR-0061): a drop is a free move (pinned), a reorder (the step-move operation) or a snap back.
  const onNodeDragStop = (_: unknown, dragged: Node) => {
    const id = dragged.id;
    const done = () =>
      setDragPos((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id)));
    const outcome = dragOutcome({
      id,
      dropped: dragged.position ?? dragPos[id],
      graph: view.graph,
      drawn: view.layout,
      stored: layout,
      sizes,
    });
    if (outcome === null || outcome.kind === "revert") return done();
    const saved =
      outcome.kind === "move"
        ? onNodeMove?.(id, outcome.position)
        : onNodeReorder?.(id, outcome.over);
    if (saved === undefined) return done();
    // The app's handlers report their own failures (snackbar); a rejection that still gets here must not go unhandled.
    saved.catch(() => undefined).finally(done);
  };

  return (
    <div
      ref={flowWrap}
      className="md3-flow-wrap"
      onFocus={(e) => setFocused(nodeIdOf(e.target))}
      onBlur={() => setFocused(null)}
    >
      <EdgeInsertContext.Provider value={insertState}>
        <ReactFlow
          nodes={shownNodes}
          edges={edges}
          edgeTypes={EDGE_TYPES}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={fitViewOptions}
          minZoom={0.1}
          onNodesChange={onNodesChange}
          nodesDraggable={onNodeMove !== undefined}
          onNodeDragStop={onNodeDragStop}
          onEdgesChange={onEdgesChange}
          onEdgeMouseEnter={(_, edge) => hover(edge.id)}
          onEdgeMouseLeave={() => hover(null)}
          onMoveStart={() => setOpenEdge(null)}
          onNodeMouseEnter={(_, node) => setHovered(node.id)}
          onNodeMouseLeave={() => setHovered(null)}
          onNodeClick={(_, node) => {
            setOpenEdge(null);
            if (isGroupId(node.id)) expandLoop(node.id.slice("group:".length));
            else if (node.id !== MARKER_ID && !node.id.startsWith("outline:")) onSelect?.(node.id);
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
          <Controls showInteractive={false} fitViewOptions={{ padding: 0.15, minZoom: 0.05 }} />
          {view.graph.nodes.length > MINIMAP_OVER && (
            <MiniMap
              pannable
              zoomable
              ariaLabel="Overview of the workflow. Drag to pan, scroll to zoom."
              nodeStrokeWidth={3}
            />
          )}
          <KeepPortsMeasured sizes={sizes} />
          {focus && flashed && <FocusNode focus={focus} onDone={() => setFlashed(null)} />}
        </ReactFlow>
      </EdgeInsertContext.Provider>
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
