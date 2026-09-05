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
    expect(afterSecondStep["workflow:farewell"]).toEqual({ x: 520, y: 120 });

    // A third call/step should keep walking forward, not reset again.
    const afterThirdStep = withAutoLayout(afterSecondStep, [
      { id: "workflow:greet", column: 2 },
      { id: "workflow:farewell", column: 2 },
      { id: "workflow:cleanup", column: 2 },
    ]);

    expect(afterThirdStep["workflow:cleanup"]).toEqual({ x: 520, y: 240 });
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
    // empty row 1 (y: 120).
    expect(next["workflow:fourth"]).toEqual({ x: 520, y: 360 });
  });
});
