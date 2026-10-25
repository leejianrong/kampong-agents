import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { autoLayoutGraph, isCurrentLayout, LAYOUT_MARK } from "../../src/layout.js";
import { specToGraph } from "../../src/graph.js";
import { parseSpec } from "../../src/index.js";
import { describe, expect, it } from "vitest";
import { withAutoLayout, type LayoutMap } from "../../src/layout.js";

describe("withAutoLayout", () => {
  it("assigns a deterministic position to a node missing from the stored layout, leaving existing entries untouched", () => {
    const existing: LayoutMap = { "agent:refund-agent": { x: 0, y: 0 } };

    const next = withAutoLayout(existing, [
      { id: "agent:refund-agent", column: 0 },
      { id: "workflow:parse_request", column: 2 },
      { id: "workflow:evaluate_policy", column: 2 },
    ]);

    expect(next["agent:refund-agent"]).toEqual({ x: 0, y: 0 });
    expect(next["workflow:parse_request"]).toBeDefined();
    expect(next["workflow:evaluate_policy"]).toBeDefined();
    expect(next["workflow:parse_request"]).not.toEqual(next["workflow:evaluate_policy"]);
  });

  it("is idempotent: running it twice with the same nodes doesn't reassign positions", () => {
    const first = withAutoLayout({}, [{ id: "a", column: 0 }]);
    const second = withAutoLayout(first, [{ id: "a", column: 0 }]);

    expect(second).toEqual(first);
  });

  // Regression test for KAN-1215: withAutoLayout used to seed its per-column
  // row counter as empty on every call, so a node added on a *later* call
  // (e.g. via "Add Workflow Step" + canvas refresh) got row 0 again and
  // landed exactly on top of a node already positioned in that column.
  it("does not collide a node added on a later call with one already positioned in the same column", () => {
    // First call, as if the canvas had already rendered one workflow step
    // (`greet`) and its position was persisted to the sidecar layout.
    const afterFirstStep = withAutoLayout({}, [{ id: "workflow:greet", column: 2 }]);
    expect(afterFirstStep["workflow:greet"]).toEqual({ x: 520, y: 0 });

    // Second call, as if "Add Workflow Step" had just added `farewell` and
    // the canvas reloaded -- `greet` already has a position, `farewell`
    // doesn't.
    const afterSecondStep = withAutoLayout(afterFirstStep, [
      { id: "workflow:greet", column: 2 },
      { id: "workflow:farewell", column: 2 },
    ]);

    expect(afterSecondStep["workflow:greet"]).toEqual({ x: 520, y: 0 });
    expect(afterSecondStep["workflow:farewell"]).not.toEqual(afterSecondStep["workflow:greet"]);
    expect(afterSecondStep["workflow:farewell"]).toEqual({ x: 520, y: 140 });

    // A third call/step should keep walking forward, not reset again.
    const afterThirdStep = withAutoLayout(afterSecondStep, [
      { id: "workflow:greet", column: 2 },
      { id: "workflow:farewell", column: 2 },
      { id: "workflow:cleanup", column: 2 },
    ]);

    expect(afterThirdStep["workflow:cleanup"]).toEqual({ x: 520, y: 280 });
  });

  // "Next free row" is defined as one past the highest occupied row in a
  // column (append-only) -- a gap left by a deleted node is not backfilled.
  // Pinning that choice so future changes don't accidentally start filling
  // gaps (which would move a node's row whenever an unrelated node in the
  // same column is deleted).
  it("appends after the highest occupied row rather than backfilling a gap left by a deleted node", () => {
    // Row 0 and row 2 of the workflow column are occupied; row 1 is a gap
    // (e.g. the step that used to live there was deleted from the spec).
    const layoutWithGap: LayoutMap = {
      "workflow:first": { x: 520, y: 0 },
      "workflow:third": { x: 520, y: 240 },
    };

    const next = withAutoLayout(layoutWithGap, [
      { id: "workflow:first", column: 2 },
      { id: "workflow:third", column: 2 },
      { id: "workflow:fourth", column: 2 },
    ]);

    // The new node goes after the highest occupied row (240), not into the
    // empty row 1 (y: 140).
    expect(next["workflow:fourth"]).toEqual({ x: 520, y: 380 });
  });
});

// KAM-238 (ADR-0059): the canvas flows left to right.

describe("autoLayoutGraph", () => {
  const source = readFileSync(
    resolve(process.cwd(), "packages/cli/templates/market-etl/agent.yaml"),
    "utf8",
  );
  const graph = specToGraph(parseSpec(source).spec!);
  const layout = autoLayoutGraph(graph);

  it("puts each step one column right of the one before it, on one row", () => {
    const run = ["agent:market_etl", "workflow:each_symbol", "workflow:fetch", "workflow:check"];
    const trigger = graph.nodes.find((n) => n.kind === "agent")!.id;
    const ids = [trigger, ...run.slice(1)];
    const xs = ids.map((id) => layout[id]!.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(xs.length);
    expect(new Set(ids.map((id) => layout[id]!.y)).size).toBe(1);
  });

  it("gives no two nodes the same place", () => {
    const places = Object.entries(layout)
      .filter(([id]) => id !== LAYOUT_MARK)
      .map(([, p]) => `${p.x},${p.y}`);
    expect(new Set(places).size).toBe(places.length);
  });

  it("puts a tool under the first step that calls it", () => {
    expect(layout["tool:fetch_daily"]!.x).toBe(layout["workflow:fetch"]!.x);
    expect(layout["tool:fetch_daily"]!.y).toBeGreaterThan(layout["workflow:fetch"]!.y);
  });

  it("is marked as the current layout, which an old top-to-bottom one is not", () => {
    expect(isCurrentLayout(layout)).toBe(true);
    expect(isCurrentLayout({ a: { x: 0, y: 0 } })).toBe(false);
  });
});
