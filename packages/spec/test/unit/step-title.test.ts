import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/index.js";

// KAM-290: a step may carry a plain-words `title`. It is optional, allowed on every kind of step, and only
// metadata: the step's `step` id stays the name a reference reads.

const spec = (version: string, steps: string) => `version: "${version}"
agent:
  id: a
  name: A
  role: R
  goal: G
  model:
    provider: ollama
    name: llama3
  tools:
    - name: t
      action: http_request
      method: GET
      url: "https://example.test"
  workflow:
${steps}
`;

const ok = (version: string, steps: string) => {
  const r = parseSpec(spec(version, steps));
  expect(r.errors).toEqual([]);
  return r.spec!;
};

describe("step title (KAM-290)", () => {
  it("is accepted on an action, tool, condition, approval step, in 1.0 and 1.1", () => {
    for (const version of ["1.0", "1.1"]) {
      const s = ok(
        version,
        `    - step: draft
      title: Write the reply
      action: summarise
    - step: fetch
      title: Look up the order
      type: tool
      tool: t
    - step: ask
      title: Ask a person
      type: approval
      message: Send it?`,
      );
      expect(s.agent.workflow.map((w) => (w as { title?: string }).title)).toEqual([
        "Write the reply",
        "Look up the order",
        "Ask a person",
      ]);
    }
  });

  it("is accepted on the 1.1 data steps, a loop, a branch and a stop", () => {
    ok(
      "1.1",
      `    - step: shape
      title: Tidy the data
      type: transform
      set:
        n: "1"
    - step: each
      title: For every symbol
      foreach:
        items: "[1]"
        as: x
        steps:
          - step: inner
            title: Handle one
            type: transform
            set:
              y: "x"
    - step: route
      title: Pick a path
      branch:
        if: "true"
        then:
          - step: done
            title: Stop here
            stop:
              reason: nothing to do`,
    );
  });

  it("is optional, and an empty one or one over 80 characters is refused", () => {
    ok("1.0", `    - step: draft\n      action: summarise`);
    const empty = parseSpec(
      spec("1.0", `    - step: draft\n      title: ""\n      action: summarise`),
    );
    expect(empty.errors.length).toBeGreaterThan(0);
    const long = parseSpec(
      spec("1.0", `    - step: draft\n      title: "${"x".repeat(81)}"\n      action: summarise`),
    );
    expect(long.errors.length).toBeGreaterThan(0);
  });

  it("does not change what a reference reads: the step's id, not its title", () => {
    const s = ok(
      "1.1",
      `    - step: shape
      title: Tidy the data
      type: transform
      set:
        n: "1"
    - step: check
      type: validate
      assert: "shape.n = 1"`,
    );
    expect(s.agent.workflow[0]).toMatchObject({ step: "shape", title: "Tidy the data" });
  });
});
