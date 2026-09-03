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
});
