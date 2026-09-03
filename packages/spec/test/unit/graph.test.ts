import { describe, expect, it } from "vitest";
import { specToGraph } from "../../src/graph.js";
import { parseSpec } from "../../src/parse.js";
import { VALID_FIXTURE_WITH_CONDITION } from "../fixtures.js";

describe("specToGraph", () => {
  it("produces one node per tool, workflow step, and a guardrails node, chained in order", () => {
    const { spec } = parseSpec(VALID_FIXTURE_WITH_CONDITION);
    const graph = specToGraph(spec!);

    expect(graph.nodes.filter((n) => n.kind === "agent")).toHaveLength(1);
    expect(graph.nodes.filter((n) => n.kind === "tool")).toHaveLength(2);
    expect(graph.nodes.filter((n) => n.kind === "workflow")).toHaveLength(3);
    expect(graph.nodes.filter((n) => n.kind === "guardrails")).toHaveLength(1);

    // agent -> step1 -> step2 -> step3, sequentially
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges[0]?.source).toBe("agent:refund-agent");
    expect(graph.edges[0]?.target).toBe("workflow:parse_request");
    expect(graph.edges[2]?.target).toBe("workflow:handle_approval");
  });

  it("round-trips each node's data back to its source YAML fragment", () => {
    const { spec } = parseSpec(VALID_FIXTURE_WITH_CONDITION);
    const graph = specToGraph(spec!);

    const tool = graph.nodes.find((n) => n.id === "tool:issue_refund");
    expect(tool?.data).toMatchObject({ method: "POST", requires_approval: true });

    const conditionStep = graph.nodes.find((n) => n.id === "workflow:handle_approval");
    expect(conditionStep?.data).toMatchObject({
      type: "condition",
      if: "evaluation.eligible == true",
    });

    const guardrails = graph.nodes.find((n) => n.kind === "guardrails");
    expect(guardrails?.data).toMatchObject({ confidence_threshold: 0.85 });
  });
});
