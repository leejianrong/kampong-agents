import { describe, expect, it } from "vitest";
import { describeRunWith } from "../../src/runWith.js";

// KAM-306: two runs with different vars or input read differently in the Runs list.

const declared = [
  { name: "symbols", type: "list" as const, items: "string" as const, default: "AAPL,MSFT,NVDA" },
  { name: "threshold", type: "number" as const, default: "1.5" },
];

describe("describeRunWith", () => {
  it("says a list var by its length and a number by its value", () => {
    const symbols = Array.from({ length: 25 }, (_, i) => `S${i}`).join(",");
    expect(describeRunWith("", declared, { symbols, threshold: "3" })).toBe(
      "symbols: 25 items, threshold: 3",
    );
    expect(describeRunWith("", declared, { symbols: "AAPL" })).toBe("symbols: 1 item");
  });

  it("adds a short input, and reads a run with nothing changed as default values", () => {
    expect(describeRunWith("hello   there", declared, {})).toBe("input: hello there");
    expect(describeRunWith("", declared, {})).toBe("default values");
    expect(describeRunWith("", [], {})).toBe("");
  });

  it("cuts a long value", () => {
    const text = describeRunWith("x".repeat(80), [], {});
    expect(text.length).toBeLessThan(45);
    expect(text.endsWith("…")).toBe(true);
  });
});
