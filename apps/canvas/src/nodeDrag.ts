import type { SpecGraph } from "@kampong/spec";
import { FALLBACK_SIZE } from "./loopGroups.js";

// KAM-186 (ADR-0061): what dropping a dragged card means. Dropped on empty canvas it is a free move that is pinned
// in the layout store. Dropped on another step of the same list it takes that step's place in the run order (the
// step-move operation, ADR-0055). Anywhere else that is not allowed it goes back where it was.

type Point = { x: number; y: number };
type Layout = Record<string, Point>;
type Sizes = Record<string, { width: number; height: number }>;

export type DragOutcome =
  /** Pin the node at `position`, in the stored layout's own coordinates. */
  | { kind: "move"; id: string; position: Point }
  /** Move the step to the place of `over`, which is in the same list. */
  | { kind: "reorder"; id: string; over: string }
  /** Nothing is saved and the card returns to where it was. */
  | { kind: "revert"; id: string };

/** Below this many pixels of travel a drag is a click that wobbled, and saves nothing. */
const WOBBLE = 3;

export function dragOutcome(input: {
  id: string;
  /** Where the card was dropped, in drawn coordinates. */
  dropped: Point;
  /** The graph as drawn (collapsed loops folded away) and the positions it is drawn at. */
  graph: SpecGraph;
  drawn: Layout;
  /** The stored layout. It differs from `drawn` where a collapsed loop closed up the room it gave back. */
  stored: Layout;
  sizes: Sizes;
}): DragOutcome | null {
  const { id, dropped, graph, drawn, stored, sizes } = input;
  const from = drawn[id];
  const node = graph.nodes.find((n) => n.id === id);
  if (!from || !node) return null;
  if (Math.hypot(dropped.x - from.x, dropped.y - from.y) < WOBBLE) return null;

  const size = sizes[id] ?? FALLBACK_SIZE;
  const centre = { x: dropped.x + size.width / 2, y: dropped.y + size.height / 2 };
  const over = graph.nodes.find((other) => {
    if (other.id === id) return false;
    const at = drawn[other.id];
    if (!at) return false;
    const box = sizes[other.id] ?? FALLBACK_SIZE;
    return (
      centre.x >= at.x &&
      centre.x <= at.x + box.width &&
      centre.y >= at.y &&
      centre.y <= at.y + box.height
    );
  });

  if (over === undefined) {
    const was = stored[id] ?? from;
    return {
      kind: "move",
      id,
      position: { x: was.x + (dropped.x - from.x), y: was.y + (dropped.y - from.y) },
    };
  }
  const sameList =
    node.kind === "workflow" &&
    over.kind === "workflow" &&
    node.parent === over.parent &&
    node.arm === over.arm;
  return sameList ? { kind: "reorder", id, over: over.id } : { kind: "revert", id };
}
