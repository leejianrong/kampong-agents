import { describe, expect, it } from "vitest";
import { getModelPricing } from "../../src/auth/env.js";
import { parseUsageDays, toBucket } from "../../src/usage/usage.js";

describe("usage report helpers (KAM-325)", () => {
  it("parses the day window: default 30, whole numbers, at most 90", () => {
    expect(parseUsageDays(undefined)).toBe(30);
    expect(parseUsageDays("7")).toBe(7);
    expect(parseUsageDays("500")).toBe(90);
    expect(parseUsageDays("0")).toBe(30);
    expect(parseUsageDays("abc")).toBe(30);
  });

  it("turns a database row into a bucket, with null cost kept null (never zero)", () => {
    expect(
      toBucket({ runs: 3, tokens_in: "1200", tokens_out: "300", cost: null, cost_runs: 0 }),
    ).toEqual({ runs: 3, tokensIn: 1200, tokensOut: 300, costUsd: null, costRuns: 0 });
    expect(
      toBucket({ runs: 2, tokens_in: null, tokens_out: null, cost: "0.012500", cost_runs: 2 }),
    ).toEqual({ runs: 2, tokensIn: 0, tokensOut: 0, costUsd: 0.0125, costRuns: 2 });
  });
});

describe("getModelPricing (KAM-325)", () => {
  it("is undefined when unset, so no price is ever guessed", () => {
    expect(getModelPricing({})).toBeUndefined();
    expect(getModelPricing({ MODEL_PRICING_JSON: "  " })).toBeUndefined();
  });
  it("reads prices by model name", () => {
    expect(
      getModelPricing({
        MODEL_PRICING_JSON: '{"gpt-4o-mini":{"inputPerMTok":0.15,"outputPerMTok":0.6}}',
      }),
    ).toEqual({ "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 } });
  });
  it("refuses bad JSON, a non-object and a price that is not two non-negative numbers", () => {
    expect(() => getModelPricing({ MODEL_PRICING_JSON: "{" })).toThrow(/valid JSON/);
    expect(() => getModelPricing({ MODEL_PRICING_JSON: "[]" })).toThrow(/object/);
    expect(() => getModelPricing({ MODEL_PRICING_JSON: '{"m":{"inputPerMTok":1}}' })).toThrow(
      /"m" needs/,
    );
    expect(() =>
      getModelPricing({ MODEL_PRICING_JSON: '{"m":{"inputPerMTok":-1,"outputPerMTok":1}}' }),
    ).toThrow(/"m" needs/);
  });
});
