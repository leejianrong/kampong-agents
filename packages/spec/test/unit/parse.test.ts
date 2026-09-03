import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/parse.js";
import { VALID_FIXTURE } from "../fixtures.js";

describe("parseSpec", () => {
  it("parses a valid fixture", () => {
    const result = parseSpec(VALID_FIXTURE);
    expect(result.success).toBe(true);
    expect(result.spec?.agent.id).toBe("refund-agent");
    expect(result.errors).toHaveLength(0);
  });

  it("rejects a wrong-type field value with a field path and a line number", () => {
    const bad = VALID_FIXTURE.replace("confidence_threshold: 0.85", 'confidence_threshold: "high"');
    const result = parseSpec(bad);

    expect(result.success).toBe(false);
    const err = result.errors.find(
      (e) => e.path.join(".") === "agent.guardrails.confidence_threshold",
    );
    expect(err).toBeDefined();
    expect(err?.line).toBeGreaterThan(0);
  });

  it("rejects an invalid HTTP method enum value with a field path", () => {
    const bad = VALID_FIXTURE.replace("method: GET", "method: FETCH");
    const result = parseSpec(bad);

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path.join(".") === "agent.tools.0.method")).toBe(true);
  });

  it("rejects a spec missing a required field, naming the field in the path", () => {
    const bad = VALID_FIXTURE.replace(
      '  goal: "Review incoming refund requests and process eligible ones."\n',
      "",
    );
    const result = parseSpec(bad);

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path.join(".") === "agent.goal")).toBe(true);
  });

  it("rejects a YAML syntax error with a line number, not a generic parse failure", () => {
    const bad = 'version: "1.0"\nagent:\n  id: refund-agent\n  tools: [\n';
    const result = parseSpec(bad);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.line).toBeGreaterThan(0);
  });
});
