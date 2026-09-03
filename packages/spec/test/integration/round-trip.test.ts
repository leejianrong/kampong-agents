import { describe, expect, it } from "vitest";
import { applyPatch } from "../../src/mutate.js";
import { parseSpec, toYamlString } from "../../src/parse.js";
import {
  VALID_FIXTURE,
  VALID_FIXTURE_NO_TOOLS,
  VALID_FIXTURE_WITH_CONDITION,
} from "../fixtures.js";

// The highest-leverage test in the whole plan (PLAN.md "Testing approach",
// SLICES.md V1 / KAN-1102): parse -> render -> mutate -> serialize ->
// re-parse must be a fixed point, including preserved comments and
// formatting -- the reason this project uses the `yaml` package instead of
// js-yaml (ADR-0007).

describe("AgentSpec round-trip duality", () => {
  it.each([
    ["single tool, no conditionals", VALID_FIXTURE],
    ["two tools with a conditional step", VALID_FIXTURE_WITH_CONDITION],
    ["no tools", VALID_FIXTURE_NO_TOOLS],
  ])("re-serializes %s byte-for-byte with zero mutations", (_name, source) => {
    const { doc, success } = parseSpec(source);
    expect(success).toBe(true);
    expect(toYamlString(doc)).toBe(source);
  });

  it("preserves comments and untouched fields when a canvas mutation touches only one field", () => {
    const { doc, success } = parseSpec(VALID_FIXTURE);
    expect(success).toBe(true);

    applyPatch(doc, [{ op: "set", path: ["agent", "goal"], value: "Updated goal text" }]);
    const output = toYamlString(doc);

    // the leading comment, untouched by the mutation, survives
    expect(output).toContain("# Refund processing agent");
    // the mutated field changed
    expect(output).toContain("Updated goal text");
    // everything else is byte-identical apart from the one changed line
    const originalLines = VALID_FIXTURE.split("\n");
    const updatedLines = output.split("\n");
    const changedLines = originalLines.filter((line, i) => line !== updatedLines[i]);
    expect(changedLines).toEqual([
      '  goal: "Review incoming refund requests and process eligible ones."',
    ]);

    const reparsed = parseSpec(output);
    expect(reparsed.success).toBe(true);
    expect(reparsed.spec?.agent.goal).toBe("Updated goal text");
  });

  it("adds a new tool without disturbing existing tools or comments", () => {
    const { doc, success } = parseSpec(VALID_FIXTURE);
    expect(success).toBe(true);

    applyPatch(doc, [
      {
        op: "add",
        path: ["agent", "tools"],
        value: {
          name: "issue_refund",
          action: "http_request",
          method: "POST",
          url: "https://api.stripe.com/v1/refunds",
        },
      },
    ]);
    const output = toYamlString(doc);

    expect(output).toContain("# Refund processing agent");
    expect(output).toContain("check_stripe_charge");
    expect(output).toContain("issue_refund");

    const reparsed = parseSpec(output);
    expect(reparsed.success).toBe(true);
    expect(reparsed.spec?.agent.tools).toHaveLength(2);
  });

  it("adds the first item to a collection that doesn't exist yet as a one-item array, not a bare value", () => {
    // Regression test: yaml's Document.addIn only appends to an existing
    // collection -- if the target path doesn't exist yet, it sets the path
    // to the bare value instead of wrapping it in a new array. Caught via
    // the canvas "Add Tool" flow against a spec with no `tools:` key yet.
    const { doc, success } = parseSpec(VALID_FIXTURE_NO_TOOLS);
    expect(success).toBe(true);

    applyPatch(doc, [
      {
        op: "add",
        path: ["agent", "tools"],
        value: { name: "check_status", action: "http_request", method: "GET", url: "https://x" },
      },
    ]);
    const reparsed = parseSpec(toYamlString(doc));

    expect(reparsed.success).toBe(true);
    expect(Array.isArray(reparsed.spec?.agent.tools)).toBe(true);
    expect(reparsed.spec?.agent.tools).toHaveLength(1);
  });

  it("removes a field cleanly via a remove patch op", () => {
    const { doc, success } = parseSpec(VALID_FIXTURE);
    expect(success).toBe(true);

    applyPatch(doc, [{ op: "remove", path: ["agent", "guardrails", "fallback_action"] }]);
    const reparsed = parseSpec(toYamlString(doc));

    expect(reparsed.success).toBe(true);
    expect(reparsed.spec?.agent.guardrails?.fallback_action).toBeUndefined();
    expect(reparsed.spec?.agent.guardrails?.confidence_threshold).toBe(0.85);
  });
});
