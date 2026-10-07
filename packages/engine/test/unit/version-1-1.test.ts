import { describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import type { ModelClient } from "../../src/model.js";
import { AgentRun, createAgentRun } from "../../src/run.js";

// KAN-1840: a version "1.1" spec is valid, but the evaluator that runs it (KAN-1841) is not here yet, so
// the engine refuses it by name instead of misreading its conditions with the 1.0 grammar.

const spec = (version: string) =>
  ({
    version,
    agent: {
      id: "a",
      name: "A",
      role: "R",
      goal: "G",
      workflow: [{ step: "s", action: "say" }],
    },
  }) as unknown as AgentSpec;

const model: ModelClient = {
  async generateText() {
    return "ok";
  },
  async generateStructured<T>() {
    return { result: {}, confidence: 1 } as T;
  },
};

describe("version 1.1 specs", () => {
  it("are refused by name when a run is created, with what to do", () => {
    const message = /version "1.1" \(expressions and vars\).*cannot run yet.*Set version to "1.0"/s;
    expect(() => createAgentRun(spec("1.1"), { model })).toThrow(message);
    expect(() => new AgentRun(spec("1.1"), { model })).toThrow(message);
  });

  it("do not stop a 1.0 spec", async () => {
    const run = createAgentRun(spec("1.0"), { model });
    expect((await run.start("hi")).status).toBe("completed");
  });
});
