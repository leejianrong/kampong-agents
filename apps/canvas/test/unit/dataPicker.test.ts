import { diagnoseExpression, type ExpressionScope } from "@kampong/spec";
import { describe, expect, it } from "vitest";
import {
  flattenPaths,
  pathKey,
  pickerGroups,
  previewOf,
  referenceText,
  samplesFrom,
} from "../../src/dataPicker.js";
import { emptyTracker, type RunTracker } from "../../src/runStatus.js";

// KAM-218: what the Insert data picker offers, and that every reference it offers passes the expression check.

const SCOPE: ExpressionScope = {
  vars: [{ name: "limit", detail: "number, default 5" }],
  steps: [
    { name: "quote", fields: ["price"] },
    { name: "later", fields: [] },
  ],
  ready: [{ name: "quote", fields: ["price"] }],
  trigger: ["repo"],
};

const TRACKER: RunTracker = {
  ...emptyTracker,
  runId: "r1",
  entries: {
    quote: {
      outcome: "completed",
      output: { price: 12.5, symbol: "MSFT", "x-id": 1, rows: [{ a: 1 }] },
    },
    "each[1].inner": { outcome: "completed", output: { n: 2 } },
    broken: { outcome: "failed", error: "boom" },
  },
};

describe("pathKey and previewOf", () => {
  it("backticks a key that is not a plain name", () => {
    expect(pathKey("price")).toBe("price");
    expect(pathKey("x-github-event")).toBe("`x-github-event`");
  });

  it("shortens a value to one recognisable line", () => {
    expect(previewOf("hi")).toBe('"hi"');
    expect(previewOf(12.5)).toBe("12.5");
    expect(previewOf([1, 2])).toBe("list of 2");
    expect(previewOf({ a: 1 })).toBe("object");
    expect(previewOf("x".repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe("flattenPaths", () => {
  it("lists the value and each path below it, a list through its first item", () => {
    const got = flattenPaths("quote", TRACKER.entries["quote"]!.output).map((i) => i.path);
    expect(got).toEqual([
      "quote",
      "quote.price",
      "quote.symbol",
      "quote.`x-id`",
      "quote.rows",
      "quote.rows[0]",
      "quote.rows[0].a",
    ]);
  });

  it("stops at a bounded number of paths", () => {
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    expect(flattenPaths("s", wide).length).toBeLessThanOrEqual(60);
  });
});

describe("samplesFrom", () => {
  it("takes finished step outputs by step name, a loop's inner step by its own name", () => {
    expect(samplesFrom(TRACKER, "hello")).toEqual({
      steps: { quote: TRACKER.entries["quote"]!.output, inner: { n: 2 } },
      input: "hello",
    });
  });
});

describe("pickerGroups", () => {
  it("gives sampled steps their values and unsampled ones the names the spec knows", () => {
    const groups = pickerGroups(SCOPE, samplesFrom(TRACKER));
    const quote = groups.find((g) => g.id === "step:quote")!;
    expect(quote.sampled).toBe(true);
    expect(quote.items.find((i) => i.path === "quote.price")?.preview).toBe("12.5");
    // `later` has not run by this field, so it is not offered at all.
    expect(groups.find((g) => g.id === "step:later")).toBeUndefined();
    expect(groups.find((g) => g.id === "vars")?.items[0]).toEqual({
      path: "vars.limit",
      preview: "number, default 5",
    });
    const trigger = groups.find((g) => g.id === "trigger")!;
    expect(trigger.items.map((i) => i.path)).toEqual([
      "trigger",
      "trigger.headers",
      "trigger.body",
      "trigger.repo",
    ]);
  });

  it("lists only known fields, without values, before any run", () => {
    const quote = pickerGroups(SCOPE, { steps: {} }).find((g) => g.id === "step:quote")!;
    expect(quote.sampled).toBe(false);
    expect(quote.items).toEqual([{ path: "quote" }, { path: "quote.price" }]);
  });

  it("offers a webhook's when and map only the request, and a poll's item fields nothing", () => {
    expect(pickerGroups({ ...SCOPE, kind: "ingress" }, { steps: {} }).map((g) => g.id)).toEqual([
      "trigger",
    ]);
    expect(pickerGroups({ ...SCOPE, kind: "item" }, { steps: {} })).toEqual([]);
  });

  it("offers a loop's own item first", () => {
    const groups = pickerGroups({ ...SCOPE, local: [{ name: "item", fields: [] }] }, { steps: {} });
    expect(groups[0]?.id).toBe("local:item");
  });

  it("every reference it offers, with values or without, passes the expression check", () => {
    for (const samples of [samplesFrom(TRACKER, "hi"), { steps: {} }]) {
      for (const group of pickerGroups(SCOPE, samples)) {
        for (const item of group.items) {
          expect(diagnoseExpression(item.path, SCOPE), item.path).toEqual([]);
        }
      }
    }
    expect(diagnoseExpression("trigger.body.x", { ...SCOPE, kind: "ingress" })).toEqual([]);
  });
});

describe("referenceText", () => {
  it("wraps a reference in braces for a prompt, and leaves it bare in an expression", () => {
    expect(referenceText("quote.price", true)).toBe("{{ quote.price }}");
    expect(referenceText("quote.price", false)).toBe("quote.price");
  });
});
