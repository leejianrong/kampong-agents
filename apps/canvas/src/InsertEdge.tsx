import { BaseEdge, EdgeLabelRenderer, useStore, type EdgeProps } from "@xyflow/react";
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { routeEdgeAcross, type Rect } from "./edgeRoute.js";
import { StepPicker } from "./StepPicker.js";
import type { StepKind } from "./stepKinds.js";

// A line between two steps with a "+" on it (KAM-213). The "+" shows when the line is hovered or has focus, and
// opens the same picker as the palette; choosing a kind opens the Add Workflow Step form at that place. A line
// is a tab stop too: Enter on it opens the picker (Canvas.tsx turns the edge's selection into that).

export interface EdgeInsertState {
  version?: string;
  /** The edge whose "+" is under the pointer. */
  hoverId: string | null;
  hover: (id: string | null) => void;
  /** The edge whose picker is open. */
  openId: string | null;
  open: (id: string) => void;
  close: (restoreFocus: boolean) => void;
  choose: (id: string, kind: StepKind) => void;
}

export const EdgeInsertContext = createContext<EdgeInsertState | null>(null);

export interface InsertEdgeData extends Record<string, unknown> {
  /** The step the new one goes in front of, for the button's name. Without it the line has no "+". */
  before?: string;
}

/** Every node but the two ends and the insertion marker, as `id:x,y,w,h` so a store selector can compare it as a string. */
function obstaclesSignature(skip: string[]) {
  return (state: {
    nodeLookup: Map<
      string,
      {
        internals: { positionAbsolute: { x: number; y: number } };
        measured: { width?: number; height?: number };
      }
    >;
  }): string => {
    const out: string[] = [];
    for (const [id, node] of state.nodeLookup) {
      if (skip.includes(id)) continue;
      const { x, y } = node.internals.positionAbsolute;
      out.push(`${x},${y},${node.measured.width ?? 180},${node.measured.height ?? 60}`);
    }
    return out.join(";");
  };
}

const POPOVER_WIDTH = 272;
const MARGIN = 8;

/**
 * The picker, in a portal on the page and placed beside the "+" with fixed coordinates: inside the canvas it would
 * sit under the nodes and be cut off by the pane. It opens below the "+", or above it when there is no room.
 */
function EdgePopover({
  anchor,
  label,
  version,
  onChoose,
  onEscape,
}: {
  anchor: HTMLElement | null;
  label: string;
  version?: string;
  onChoose: (kind: StepKind) => void;
  onEscape: () => void;
}) {
  const [style, setStyle] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  }>();
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - MARGIN * 2;
    const above = r.top - MARGIN * 2;
    const left = Math.max(
      MARGIN,
      Math.min(
        r.left + r.width / 2 - POPOVER_WIDTH / 2,
        window.innerWidth - POPOVER_WIDTH - MARGIN,
      ),
    );
    setStyle(
      below >= 280 || below >= above
        ? { left, top: r.bottom + MARGIN, maxHeight: Math.min(400, below) }
        : { left, bottom: window.innerHeight - r.top + MARGIN, maxHeight: Math.min(400, above) },
    );
  }, [anchor]);
  return createPortal(
    <div
      className="md3-edge-plus__popover"
      role="dialog"
      aria-label={label}
      style={{ width: POPOVER_WIDTH, ...(style ?? { left: -9999, top: 0 }) }}
    >
      <StepPicker
        version={version}
        label="Search steps to insert"
        autoFocus
        onChoose={onChoose}
        onEscape={onEscape}
      />
    </div>,
    document.body,
  );
}

export function InsertEdge(props: EdgeProps) {
  const button = useRef<HTMLButtonElement>(null);
  const state = useContext(EdgeInsertContext);
  const { id, sourceX, sourceY, targetX, targetY, label, source, target } = props;
  const signature = useStore(obstaclesSignature([source, target, "insertion-marker"]));
  const route = useMemo(() => {
    const obstacles: Rect[] = signature
      .split(";")
      .filter((part) => part !== "")
      .map((part) => {
        const [x, y, width, height] = part.split(",").map(Number) as [
          number,
          number,
          number,
          number,
        ];
        return { x, y, width, height };
      });
    return routeEdgeAcross({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, obstacles);
  }, [signature, sourceX, sourceY, targetX, targetY]);
  // A labelled line (a branch arm) keeps its label at the middle, so the "+" sits nearer the step it leads to.
  const labelled = label !== undefined && label !== "";
  const x = labelled && !route.detoured ? sourceX + (targetX - sourceX) * 0.8 : route.mid.x;
  const y = labelled && !route.detoured ? sourceY + (targetY - sourceY) * 0.8 : route.mid.y;
  const insertBefore = (props.data as InsertEdgeData | undefined)?.before;
  const before = insertBefore ?? "this step";
  const isOpen = state?.openId === id;
  const visible = isOpen || state?.hoverId === id;

  return (
    <>
      <BaseEdge
        id={id}
        path={route.path}
        {...(label !== undefined && { label, labelX: route.mid.x, labelY: route.mid.y })}
        interactionWidth={24}
      />
      {state && insertBefore !== undefined && (
        <EdgeLabelRenderer>
          <div
            className="md3-edge-plus nodrag nopan nowheel"
            style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
            data-visible={visible}
            // React events cross the portal into the edge's own handlers: a click or Enter in here would
            // select the line, and that opens its picker again.
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onMouseEnter={() => state.hover(id)}
            onMouseLeave={() => state.hover(null)}
          >
            <button
              ref={button}
              type="button"
              className="md3-edge-plus__button"
              data-edge={id}
              aria-label={`Insert a step before ${before}`}
              aria-haspopup="dialog"
              aria-expanded={isOpen}
              tabIndex={-1}
              onClick={() => (isOpen ? state.close(true) : state.open(id))}
            >
              +
            </button>
            {isOpen && (
              <EdgePopover
                anchor={button.current}
                label={`Insert a step before ${before}`}
                version={state.version}
                onChoose={(kind) => state.choose(id, kind)}
                onEscape={() => state.close(true)}
              />
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
