import { describe, expect, it } from "vitest";
import type { SpecGraph, SpecNode } from "@kampong/spec";
import { dragOutcome } from "../../src/nodeDrag.js";

// KAM-186 (ADR-0061): what dropping a dragged card means.

const node = (id: string, extra: Partial<SpecNode> = {}): SpecNode => ({
  id,
  kind: "workflow",
  column: 0,
  data: {},
  ...extra,
});

const graph: SpecGraph = {
  nodes: [
    node("workflow:a"),
    node("workflow:b"),
    node("workflow:c"),
    node("workflow:inner", { parent: "workflow:loop" }),
    node("tool:t", { kind: "tool" }),
  ],
  edges: [],
};
const drawn = {
  "workflow:a": { x: 0, y: 0 },
  "workflow:b": { x: 320, y: 0 },
  "workflow:c": { x: 640, y: 0 },
  "workflow:inner": { x: 640, y: 300 },
  "tool:t": { x: 0, y: 600 },
};
const sizes = {};

const drop = (id: string, dropped: { x: number; y: number }, stored = drawn) =>
  dragOutcome({ id, dropped, graph, drawn, stored, sizes });

describe("dragOutcome", () => {
  it("dropped on empty canvas is a free move, in the stored layout's coordinates", () => {
    expect(drop("workflow:a", { x: 100, y: 400 })).toEqual({
      kind: "move",
      id: "workflow:a",
      position: { x: 100, y: 400 },
    });
    // A collapsed loop shifted what is drawn; the same travel is applied to the stored position.
    const stored = { ...drawn, "workflow:c": { x: 1280, y: 0 } };
    expect(drop("workflow:c", { x: 650, y: 20 }, stored)).toEqual({
      kind: "move",
      id: "workflow:c",
      position: { x: 1290, y: 20 },
    });
  });

  it("dropped on another step of the same list is a reorder into that step's place", () => {
    expect(drop("workflow:a", { x: 330, y: 5 })).toEqual({
      kind: "reorder",
      id: "workflow:a",
      over: "workflow:b",
    });
    expect(drop("workflow:c", { x: 10, y: 0 })).toEqual({
      kind: "reorder",
      id: "workflow:c",
      over: "workflow:a",
    });
  });

  it("dropped on a step of another list, or a tool on a step, goes back", () => {
    expect(drop("workflow:a", { x: 640, y: 300 })).toEqual({ kind: "revert", id: "workflow:a" });
    expect(drop("tool:t", { x: 320, y: 0 })).toEqual({ kind: "revert", id: "tool:t" });
  });

  it("a tool dropped on empty canvas is a free move", () => {
    expect(drop("tool:t", { x: 0, y: 900 })).toMatchObject({ kind: "move", id: "tool:t" });
  });

  it("a click that wobbled saves nothing", () => {
    expect(drop("workflow:a", { x: 1, y: 1 })).toBeNull();
  });

  it("an unknown card is ignored", () => {
    expect(drop("workflow:nope", { x: 100, y: 100 })).toBeNull();
  });
});
