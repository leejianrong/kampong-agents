import { describe, expect, it } from "vitest";
import {
  curveHits,
  curvePoints,
  routeEdge,
  routeEdgeAcross,
  type Rect,
} from "../../src/edgeRoute.js";

// KAM-185: a line between two steps never passes behind a node.

const node = (x: number, y: number, width = 200, height = 60): Rect => ({ x, y, width, height });

describe("routeEdge", () => {
  it("keeps the usual curve when nothing is in the way", () => {
    const route = routeEdge({ x: 100, y: 60 }, { x: 100, y: 120 }, [node(400, 0)]);
    expect(route.detoured).toBe(false);
    expect(route.path.startsWith("M 100 60 C")).toBe(true);
  });

  it("goes round a node that sits between the two ends", () => {
    // A branch at the top, the step after its arms below, and arm steps between them.
    const from = { x: 150, y: 60 };
    const to = { x: 100, y: 360 };
    const between = [node(100, 130), node(100, 240)];
    expect(curveHits(curvePoints(from, to), between)).toBe(true);
    const route = routeEdge(from, to, between);
    expect(route.detoured).toBe(true);
    // The lane is beside the nodes in the way, on a side clear of them.
    const lane = route.mid.x;
    expect(lane < 100 || lane > 300).toBe(true);
    expect(route.path).toContain("Q");
  });

  it("runs its lane clear of every node beside the way, such as a lane of tools", () => {
    const from = { x: 150, y: 60 };
    const to = { x: 150, y: 360 };
    const nodes = [node(100, 180), node(-60, 100, 120, 200)];
    const lane = routeEdge(from, to, nodes).mid.x;
    expect(nodes.every((r) => lane < r.x || lane > r.x + r.width)).toBe(true);
  });
});

// KAM-238: a flow that runs left to right leaves the right of a step and enters the left of the next.
describe("routeEdgeAcross", () => {
  it("is a plain curve from right to left when nothing is in the way", () => {
    const route = routeEdgeAcross({ x: 240, y: 30 }, { x: 320, y: 30 }, []);
    expect(route.detoured).toBe(false);
    expect(route.path.startsWith("M 240 30")).toBe(true);
    expect(route.path.endsWith("320 30")).toBe(true);
    expect(route.mid).toEqual({ x: 280, y: 30 });
  });

  it("goes round a node standing between the two ends", () => {
    const obstacle = { x: 280, y: -20, width: 100, height: 100 };
    const route = routeEdgeAcross({ x: 240, y: 30 }, { x: 480, y: 30 }, [obstacle]);
    expect(route.detoured).toBe(true);
    const nums = route.path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(nums.slice(0, 2)).toEqual([240, 30]);
    expect(nums.slice(-2)).toEqual([480, 30]);
  });
});
