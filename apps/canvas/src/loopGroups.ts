import type { SpecEdge, SpecGraph, SpecNode } from "@kampong/spec";

// KAM-239 (ADR-0059 §4): a loop is a rounded group around the steps in its body, with a header, and it can be
// collapsed to one card that says how many steps are inside. The spec and the stored layout are untouched: a group
// is only a drawn view of a foreach step and the steps whose `parent` chain leads to it, so nothing here is saved.

/** A loop whose body has more steps than this opens collapsed. */
export const COLLAPSE_OVER = 4;

/** What a card is taken to measure before the canvas has measured it (a card is 240 px wide). */
export const FALLBACK_SIZE = { width: 240, height: 76 };
const HEADER = 44;
const PAD = 16;
const NEST_PAD = 14;
/** The columns of the left-to-right layout are this far apart (FLOW in @kampong/spec layout.ts). */
const TOOL_STEP = 320;

export interface LoopGroup {
  /** The foreach step's node id; the group is named after it. */
  holder: string;
  /** The node id of the group itself: `group:<holder>`. */
  id: string;
  /** What the header calls it: "each symbol". */
  label: string;
  /** The ids of every step in the body, nested ones too, in graph order. */
  members: string[];
  /** How many loops sit inside this one, for the padding that keeps their outlines apart. */
  inner: number;
}

export type Rect = { x: number; y: number; width: number; height: number };
type Layout = Record<string, { x: number; y: number }>;
type Sizes = Record<string, { width: number; height: number }>;

export const groupIdOf = (holder: string) => `group:${holder}`;
export const isGroupId = (id: string) => id.startsWith("group:");

/** Whether a body of this many steps starts collapsed. */
export const collapsedByDefault = (g: LoopGroup) => g.members.length > COLLAPSE_OVER;

export function loopGroups(graph: SpecGraph): LoopGroup[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const within = (node: SpecNode, holder: string): boolean => {
    for (let p = node.parent; p !== undefined; p = byId.get(p)?.parent) {
      if (p === holder) return true;
    }
    return false;
  };
  const loops = graph.nodes.filter((n) => n.kind === "workflow" && n.data.foreach !== undefined);
  const groups = loops.map((loop): LoopGroup => {
    const as = (loop.data.foreach as { as?: string }).as;
    return {
      holder: loop.id,
      id: groupIdOf(loop.id),
      label: as !== undefined ? `each ${as}` : String(loop.data.step ?? loop.id),
      members: graph.nodes.filter((n) => within(n, loop.id)).map((n) => n.id),
      inner: 0,
    };
  });
  for (const g of groups) {
    g.inner = groups.filter((o) => o !== g && g.members.includes(o.holder)).length;
  }
  return groups.filter((g) => g.members.length > 0);
}

/** The groups a node is inside, outermost first. */
export function groupsAround(groups: LoopGroup[], id: string): LoopGroup[] {
  return groups
    .filter((g) => g.members.includes(id))
    .sort((a, b) => b.members.length - a.members.length);
}

/** The outline of an open group: its members' boxes, a header above and some room round them. */
export function groupBox(group: LoopGroup, layout: Layout, sizes: Sizes): Rect | undefined {
  const rects = group.members.flatMap((id) => {
    const at = layout[id];
    if (at === undefined) return [];
    const size = sizes[id] ?? FALLBACK_SIZE;
    return [{ x: at.x, y: at.y, ...size }];
  });
  if (rects.length === 0) return undefined;
  const pad = PAD + NEST_PAD * group.inner;
  const left = Math.min(...rects.map((r) => r.x)) - pad;
  const top = Math.min(...rects.map((r) => r.y)) - pad - HEADER;
  const right = Math.max(...rects.map((r) => r.x + r.width)) + pad;
  const bottom = Math.max(...rects.map((r) => r.y + r.height)) + pad;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export interface CollapsedGroup {
  group: LoopGroup;
  position: { x: number; y: number };
}

export interface GroupView {
  /** The graph as drawn: the steps of a collapsed loop are gone and its lines run to the group's card. */
  graph: SpecGraph;
  /** Positions of what is drawn, closed up over the room a collapsed loop gave back, plus each collapsed card. */
  layout: Layout;
  /** The loops drawn as a single card, outermost only. */
  collapsed: CollapsedGroup[];
  /** The loops drawn open. */
  open: LoopGroup[];
}

/**
 * Applies the collapsed state. The card of a collapsed loop sits where its first step was; later steps move left
 * by the width the body took, so a collapsed loop does not leave a hole. Lines into the body run to the card, and
 * lines out of it start there.
 */
export function applyCollapse(
  graph: SpecGraph,
  layout: Layout,
  groups: LoopGroup[],
  isCollapsed: (g: LoopGroup) => boolean,
): GroupView {
  const shut = groups.filter(isCollapsed);
  // The outermost collapsed group around a node is the one that draws it.
  const hiddenBy = new Map<string, LoopGroup>();
  for (const g of [...shut].sort((a, b) => b.members.length - a.members.length)) {
    for (const id of g.members) if (!hiddenBy.has(id)) hiddenBy.set(id, g);
  }
  const drawnShut = shut.filter((g) => !hiddenBy.has(g.holder));

  const xOf = (id: string) => layout[id]?.x ?? 0;
  const spans = drawnShut.map((g) => {
    const xs = g.members.map(xOf);
    return { group: g, first: Math.min(...xs), last: Math.max(...xs) };
  });
  // How far left a thing at `x` moves: the span of every collapsed loop wholly before it.
  const shiftAt = (x: number) =>
    spans.filter((s) => s.last < x).reduce((sum, s) => sum + (s.last - s.first), 0);

  const nodes = graph.nodes.filter((n) => !hiddenBy.has(n.id));
  const out: Layout = {};
  for (const [id, at] of Object.entries(layout)) {
    if (!hiddenBy.has(id)) out[id] = { x: at.x - shiftAt(at.x), y: at.y };
  }
  // A tool that only a hidden step calls would be left out in the old body's columns; it moves under the card.
  const takenX = new Set(nodes.filter((n) => n.kind === "tool").map((n) => out[n.id]?.x));
  for (const span of spans) {
    const strays = nodes
      .filter(
        (n) =>
          n.kind === "tool" &&
          out[n.id] !== undefined &&
          xOf(n.id) >= span.first &&
          xOf(n.id) <= span.last,
      )
      .sort((a, b) => xOf(a.id) - xOf(b.id));
    for (const tool of strays) {
      let x = span.first - shiftAt(span.first);
      while (takenX.has(x) && out[tool.id]?.x !== x) x += TOOL_STEP;
      takenX.add(x);
      out[tool.id] = { x, y: out[tool.id]!.y };
    }
  }
  const collapsed = spans.map(({ group, first }): CollapsedGroup => {
    const firstId = group.members.find((id) => xOf(id) === first) ?? group.members[0]!;
    const position = { x: first - shiftAt(first), y: layout[firstId]?.y ?? 0 };
    out[group.id] = position;
    return { group, position };
  });

  const ends = (id: string) => {
    const g = hiddenBy.get(id);
    return g !== undefined ? g.id : id;
  };
  const seen = new Set<string>();
  const edges: SpecEdge[] = [];
  for (const edge of graph.edges) {
    const source = ends(edge.source);
    const target = ends(edge.target);
    if (source === target) continue;
    const key = `${source}->${target}|${edge.label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(
      source === edge.source && target === edge.target
        ? edge
        : {
            ...edge,
            id: `${source}->${target}${edge.label !== undefined ? `|${edge.label}` : ""}`,
            source,
            target,
          },
    );
  }
  return {
    graph: { nodes, edges },
    layout: out,
    collapsed,
    open: groups.filter((g) => !isCollapsed(g) && !hiddenBy.has(g.holder)),
  };
}
