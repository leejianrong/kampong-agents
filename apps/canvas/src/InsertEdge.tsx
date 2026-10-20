import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  /** The step the new one goes in front of, for the button's name. */
  before: string;
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
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label } = props;
  const [path, midX, midY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  // A labelled line (a branch arm) keeps its label at the middle, so the "+" sits nearer the step it leads to.
  const t = label !== undefined && label !== "" ? 0.8 : 0.5;
  const x = label !== undefined && label !== "" ? sourceX + (targetX - sourceX) * t : midX;
  const y = label !== undefined && label !== "" ? sourceY + (targetY - sourceY) * t : midY;
  const before = String((props.data as InsertEdgeData | undefined)?.before ?? "this step");
  const isOpen = state?.openId === id;
  const visible = isOpen || state?.hoverId === id;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(label !== undefined && { label, labelX: midX, labelY: midY })}
        interactionWidth={24}
      />
      {state && (
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
