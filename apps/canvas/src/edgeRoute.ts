// Where a line between two steps runs so it never passes behind another node (KAM-185). A line leaves the bottom of
// a step and enters the top of the next. Most are a short curve; when the curve would cross a node (a branch
// falling through to the step after its arms, say) the line goes round instead: down a little, across to a lane
// beside the nodes in its way, down that lane, and back across above the target.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Route {
  /** An SVG path. */
  path: string;
  /** A point on the line for its label and its "+". */
  mid: Point;
  /** The line goes round nodes rather than straight between its two. */
  detoured: boolean;
}

/** Space kept between a line and a node, and between a lane and the nodes it passes. */
const CLEARANCE = 6;
const LANE_GAP = 28;
/** How far a detour runs straight out of the source and into the target before it turns. */
const STUB = 16;
const RADIUS = 10;
const SAMPLES = 32;

/** The points of the default curve from `from` (a bottom handle) to `to` (a top handle), as xyflow draws it. */
export function curvePoints(from: Point, to: Point): Point[] {
  const dy = to.y - from.y;
  const reach = dy >= 0 ? 0.5 * dy : 25 * Math.sqrt(-dy);
  const c1 = { x: from.x, y: from.y + reach };
  const c2 = { x: to.x, y: to.y - reach };
  const out: Point[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const u = 1 - t;
    out.push({
      x: u ** 3 * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * to.x,
      y: u ** 3 * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * to.y,
    });
  }
  return out;
}

const inside = (p: Point, r: Rect, pad: number): boolean =>
  p.x > r.x - pad && p.x < r.x + r.width + pad && p.y > r.y - pad && p.y < r.y + r.height + pad;

/** Whether a polyline of axis-aligned segments crosses a rectangle (grown by `pad`). */
function segmentHits(a: Point, b: Point, r: Rect, pad: number): boolean {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  return (
    right > r.x - pad &&
    left < r.x + r.width + pad &&
    bottom > r.y - pad &&
    top < r.y + r.height + pad
  );
}

export function curveHits(points: Point[], rects: Rect[]): boolean {
  return rects.some((r) => points.some((p) => inside(p, r, CLEARANCE)));
}

function polylineHits(points: Point[], rects: Rect[]): boolean {
  for (let i = 1; i < points.length; i++) {
    if (rects.some((r) => segmentHits(points[i - 1]!, points[i]!, r, 1))) return true;
  }
  return false;
}

/** A polyline with its corners rounded. */
function rounded(points: Point[]): string {
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const here = points[i]!;
    const next = points[i + 1]!;
    const inLen = Math.hypot(here.x - prev.x, here.y - prev.y);
    const outLen = Math.hypot(next.x - here.x, next.y - here.y);
    const r = Math.min(RADIUS, inLen / 2, outLen / 2);
    if (r < 1) {
      d += ` L ${here.x} ${here.y}`;
      continue;
    }
    const a = {
      x: here.x - ((here.x - prev.x) / inLen) * r,
      y: here.y - ((here.y - prev.y) / inLen) * r,
    };
    const b = {
      x: here.x + ((next.x - here.x) / outLen) * r,
      y: here.y + ((next.y - here.y) / outLen) * r,
    };
    d += ` L ${a.x} ${a.y} Q ${here.x} ${here.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}

function bezier(from: Point, to: Point): { path: string; mid: Point } {
  const dy = to.y - from.y;
  const reach = dy >= 0 ? 0.5 * dy : 25 * Math.sqrt(-dy);
  return {
    path: `M ${from.x} ${from.y} C ${from.x} ${from.y + reach} ${to.x} ${to.y - reach} ${to.x} ${to.y}`,
    mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
  };
}

/**
 * The line from `from` (the bottom of a step) to `to` (the top of the next), clear of `obstacles`: every node but
 * those two. It is the usual curve when that is clear, and otherwise a detour down a lane beside the nodes in the
 * way, on whichever side is nearer.
 */
export function routeEdge(from: Point, to: Point, obstacles: Rect[]): Route {
  if (!curveHits(curvePoints(from, to), obstacles)) {
    return { ...bezier(from, to), detoured: false };
  }
  const top = Math.min(from.y, to.y);
  const bottom = Math.max(from.y, to.y);
  const inTheWay = obstacles.filter((r) => r.y + r.height > top && r.y < bottom);
  const left = Math.min(from.x, to.x, ...inTheWay.map((r) => r.x)) - LANE_GAP;
  const right = Math.max(from.x, to.x, ...inTheWay.map((r) => r.x + r.width)) + LANE_GAP;
  // The runs out of the source and into the target stay inside the gap to the nearest node, so they cross none.
  const below = obstacles.filter((r) => r.y >= from.y - 1).map((r) => r.y - from.y);
  const above = obstacles
    .filter((r) => r.y + r.height <= to.y + 1)
    .map((r) => to.y - (r.y + r.height));
  const down = Math.max(2, Math.min(STUB, Math.min(...below, 2 * STUB) / 2));
  const up = Math.max(2, Math.min(STUB, Math.min(...above, 2 * STUB) / 2));
  const middle = (from.x + to.x) / 2;
  const lanes = [left, right].sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
  const through = (lane: number): Point[] => [
    from,
    { x: from.x, y: from.y + down },
    { x: lane, y: from.y + down },
    { x: lane, y: to.y - up },
    { x: to.x, y: to.y - up },
    to,
  ];
  // The first lane whose whole run is clear, else the nearer one.
  const lane = lanes.find((l) => !polylineHits(through(l).slice(1, -1), obstacles)) ?? lanes[0]!;
  const points = through(lane);
  return {
    path: rounded(points),
    mid: { x: lane, y: (from.y + to.y) / 2 },
    detoured: true,
  };
}
