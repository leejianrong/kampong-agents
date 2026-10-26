import { NodeToolbar, Position } from "@xyflow/react";
import type { NodeAction } from "./Canvas.js";

// The small toolbar that floats above the selected card (KAM-245): Duplicate and Delete, the two things a person
// does to a card that the inspector's form is not for. It only hands the action to the app, which asks before a
// delete exactly as the inspector's own button does.

const ICONS = {
  duplicate: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 012-2h9" />
    </>
  ),
  delete: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" />,
} as const;

export function CardToolbar({
  what,
  onAction,
}: {
  /** "step shape" or "tool lookup": names the toolbar. */
  what: string;
  onAction: (action: NodeAction) => void;
}) {
  return (
    <NodeToolbar isVisible position={Position.Top} offset={8}>
      <div
        className="kg-toolbar nodrag nopan"
        role="toolbar"
        aria-label={`Actions for ${what}`}
        data-testid="card-toolbar"
      >
        {(["duplicate", "delete"] as const).map((action) => (
          <button
            key={action}
            type="button"
            className="kg-toolbar__button"
            aria-label={action === "duplicate" ? "Duplicate" : "Delete"}
            title={action === "duplicate" ? "Duplicate (Ctrl+D)" : "Delete (Delete key)"}
            data-action={action}
            // The click must not reach the node under the toolbar: that would select it again.
            onClick={(e) => {
              e.stopPropagation();
              onAction(action);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              {ICONS[action]}
            </svg>
          </button>
        ))}
      </div>
    </NodeToolbar>
  );
}
