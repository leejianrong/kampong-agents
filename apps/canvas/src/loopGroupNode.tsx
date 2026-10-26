import type { NodeProps } from "@xyflow/react";
import { NodeIcon } from "./nodeCard.js";

// KAM-239: the outline drawn behind an open loop's steps, and the card a collapsed one becomes. Both are pure views
// (loopGroups.ts); the outline is a React Flow node of its own so it pans and zooms with the steps.

export interface LoopGroupData extends Record<string, unknown> {
  label: string;
  steps: number;
  onToggle: () => void;
}

const stepsWord = (n: number) => `${n} ${n === 1 ? "step" : "steps"}`;

/** The header of an open loop: its name, how many steps are inside, and the button that collapses it. */
export function LoopGroupNode({ data }: NodeProps) {
  const { label, steps, onToggle } = data as LoopGroupData;
  return (
    <div className="kg-group">
      <div className="kg-group__header">
        <button
          type="button"
          className="kg-group__toggle nodrag nopan"
          aria-expanded="true"
          aria-label={`Collapse loop ${label} (${stepsWord(steps)})`}
          data-testid="loop-toggle"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          <span aria-hidden="true">−</span>
        </button>
        <span className="kg-group__tile" aria-hidden="true">
          <NodeIcon name="loop" />
        </span>
        <span className="kg-group__title">Loop · {label}</span>
        <span className="kg-group__count">{stepsWord(steps)}</span>
      </div>
    </div>
  );
}

/** What a collapsed loop shows on its card. */
export function CollapsedLoop({ label, steps }: { label: string; steps: number }) {
  return (
    <div className="kg-card kg-card--flow">
      <div className="kg-card__tile">
        <NodeIcon name="loop" />
      </div>
      <div className="kg-card__text">
        <div className="kg-card__kind">Loop · collapsed</div>
        <div className="md3-label-large md3-node__title" title={label}>
          {label}
        </div>
        <div className="kg-card__summary md3-node__meta">
          {stepsWord(steps)} · press Enter to expand
        </div>
      </div>
    </div>
  );
}
