import { describe, expect, it } from "vitest";
import { parseSpec, toYamlString } from "../../src/parse.js";

// KAM-109: a webhook trigger can answer the caller with the final output instead of a run id.

const spec = (version: string, trigger: string) => `version: "${version}"
agent:
  id: a
  name: A
  role: R
  goal: G
  trigger:
${trigger}
  workflow:
    - step: s
      action: write
`;
const messages = (source: string) => parseSpec(source).errors.map((e) => e.message);

describe("trigger respond and timeout_ms", () => {
  it("accept sync with a timeout in 1.1 and round-trip", () => {
    const source = spec("1.1", "    type: webhook\n    respond: sync\n    timeout_ms: 45000");
    const result = parseSpec(source);
    expect(result.errors).toEqual([]);
    expect(toYamlString(result.doc)).toBe(source);
  });

  it("accept respond: async, the existing behaviour, spelled out", () => {
    expect(messages(spec("1.1", "    type: webhook\n    respond: async"))).toEqual([]);
  });

  it("need version 1.1", () => {
    expect(messages(spec("1.0", "    type: webhook\n    respond: sync"))).toContain(
      'respond needs version "1.1"',
    );
    expect(messages(spec("1.0", "    type: webhook\n    timeout_ms: 5000"))).toContain(
      'timeout_ms needs version "1.1"',
    );
  });

  it("refuse timeout_ms unless the trigger answers synchronously", () => {
    expect(messages(spec("1.1", "    type: webhook\n    timeout_ms: 5000"))).toContain(
      'timeout_ms only applies with respond: "sync"',
    );
  });

  it("refuse an unknown mode and an out-of-range timeout", () => {
    expect(parseSpec(spec("1.1", "    type: webhook\n    respond: later")).success).toBe(false);
    expect(
      parseSpec(spec("1.1", "    type: webhook\n    respond: sync\n    timeout_ms: 10")).success,
    ).toBe(false);
    expect(
      parseSpec(spec("1.1", "    type: webhook\n    respond: sync\n    timeout_ms: 999999"))
        .success,
    ).toBe(false);
  });
});
