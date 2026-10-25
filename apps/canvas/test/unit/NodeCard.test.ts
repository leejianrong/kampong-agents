import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSpec, specToGraph } from "@kampong/spec";
import { cardInfo } from "../../src/nodeCard.js";

// KAM-237 (ADR-0059): every step reads as a card with a category, a written kind, a name and a summary.
const { spec } = parseSpec(
  readFileSync(resolve(process.cwd(), "packages/cli/templates/market-etl/agent.yaml"), "utf8"),
);
const infoById = Object.fromEntries(specToGraph(spec!).nodes.map((n) => [n.id, cardInfo(n)]));

describe("cardInfo on the market-etl template", () => {
  it("splits the trigger into a name and a detail", () => {
    const trigger = Object.entries(infoById).find(([id]) => id.startsWith("agent:"))![1];
    expect(trigger).toMatchObject({ category: "trigger", kind: "Trigger", name: "Schedule" });
    expect(trigger.summary).toMatch(/^cron /);
  });

  it("gives each step kind its category and a written kind", () => {
    expect(infoById["workflow:each_symbol"]).toMatchObject({ category: "flow", kind: "Foreach" });
    expect(infoById["workflow:fetch"]).toMatchObject({ category: "tool", kind: "Tool step" });
    expect(infoById["workflow:check"]).toMatchObject({ category: "data", kind: "Validate" });
    expect(infoById["workflow:shape"]).toMatchObject({ category: "data", kind: "Transform" });
    expect(infoById["workflow:anomaly"]).toMatchObject({ category: "flow", kind: "Branch" });
    expect(infoById["workflow:summarize"]).toMatchObject({ category: "ai", kind: "AI action" });
  });

  it("summarises a tool step by the tool it calls, and a declared tool by what it does", () => {
    expect(infoById["workflow:fetch"]!.summary).toBe("calls fetch_daily");
    expect(infoById["tool:fetch_daily"]!.category).toBe("tool");
    expect(infoById["tool:fetch_daily"]!.summary).not.toBe("");
  });

  it("cuts a long summary and always gives a name", () => {
    for (const info of Object.values(infoById)) {
      expect(info.name).not.toBe("");
      expect(info.summary.length).toBeLessThanOrEqual(90);
    }
  });
});
