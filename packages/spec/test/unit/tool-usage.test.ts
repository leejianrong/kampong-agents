import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { specToGraph, toolUsage } from "../../src/graph.js";
import { parseSpec } from "../../src/parse.js";

// KAM-185: which steps use which tool, and the run reads down one column with the tools in a lane beside it.

const ETL = readFileSync(
  fileURLToPath(new URL("../../../cli/templates/market-etl/agent.yaml", import.meta.url)),
  "utf8",
);

const V10 = `version: "1.0"
agent:
  id: old
  name: Old
  role: R
  goal: G
  tools:
    - name: ping
      action: http_request
      method: GET
      url: "https://x.example/ping"
  workflow:
    - step: check
      type: condition
      if: "input.ok == yes"
      then: execute_tool(ping)
      else: execute_tool(ping)
`;

describe("toolUsage", () => {
  it("lists the steps that call each tool in the market-etl template, including nested ones", () => {
    const usage = toolUsage(specToGraph(parseSpec(ETL).spec!));
    expect(usage).toEqual({
      "tool:fetch_daily": ["workflow:fetch"],
      "tool:upsert_price": ["workflow:write"],
      "tool:post_alert": ["workflow:alert"],
    });
  });

  it("reads execute_tool(name) in a 1.0 condition, once per step", () => {
    const graph = specToGraph(parseSpec(V10).spec!);
    expect(toolUsage(graph)).toEqual({ "tool:ping": ["workflow:check"] });
  });
});

describe("specToGraph columns", () => {
  it("puts the trigger and the steps in one column and the tools in a lane to its left", () => {
    const graph = specToGraph(parseSpec(ETL).spec!);
    const col = (id: string) => graph.nodes.find((n) => n.id === id)!.column;
    expect(col("tool:fetch_daily")).toBeLessThan(col("agent:market-etl"));
    expect(Math.floor(col("workflow:report"))).toBe(Math.floor(col("agent:market-etl")));
  });
});
