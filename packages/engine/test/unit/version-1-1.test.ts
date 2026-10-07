import { describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import type { ModelClient } from "../../src/model.js";
import { createAgentRun } from "../../src/run.js";

// KAN-1841: a version 1.1 spec runs through the same AgentRun as a 1.0 one; the trigger and the vars are
// options of the run.

const spec = (version: string) =>
  ({
    version,
    vars: version === "1.1" ? { limit: { type: "number", default: 1 } } : undefined,
    agent: {
      id: "a",
      name: "A",
      role: "R",
      goal: "G",
      workflow: [
        { step: "s", action: "say" },
        {
          step: "check",
          type: "condition",
          if: version === "1.1" ? "trigger.n > vars.limit" : 's.text == "ok"',
          then: "request_human_approval",
          else: "request_human_approval",
        },
      ],
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

describe("AgentRun and a version 1.1 spec", () => {
  it("runs, reading the trigger and the vars given to the run", async () => {
    const run = createAgentRun(spec("1.1"), {
      model,
      trigger: { body: { n: 5 } },
      vars: { limit: 3 },
    });
    // Reaches the condition's approval pause: the condition was true or false, not an error.
    expect((await run.start("ignored")).status).toBe("awaiting_approval");
  });

  it("fails visibly, not silently false, when the trigger lacks what the expression reads", async () => {
    const run = createAgentRun(spec("1.1"), { model, trigger: { body: {} } });
    const state = await run.start("ignored");
    expect(state.status).toBe("failed");
    expect(JSON.stringify(state)).toContain("evaluated to nothing");
  });

  it("still runs a 1.0 spec the way it always did", async () => {
    const run = createAgentRun(spec("1.0"), { model });
    expect((await run.start("hi")).status).toBe("awaiting_approval");
  });
});
