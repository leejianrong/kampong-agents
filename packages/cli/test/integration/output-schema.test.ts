import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelClient } from "@kampong/engine";
import { EXIT_EXECUTION_FAILURE, EXIT_SUCCESS, runCli } from "../../src/cli.js";
import { capture } from "../unit/test-helpers.js";

// KAN-1843: `kampong run` on a spec whose action step declares an output_schema.

const SPEC = `version: "1.1"
agent:
  id: a
  name: A
  role: R
  goal: G
  model: { provider: ollama, name: llama3.1 }
  workflow:
    - step: triage
      action: classify
      output_schema:
        type: object
        required: [severity]
        properties:
          severity: { type: string, enum: [low, high] }
    - step: decide
      type: condition
      if: triage.severity = "high"
      then: request_human_approval
      else: request_human_approval
`;

const scripted = (answers: unknown[]): { model: ModelClient; calls: () => number } => {
  let n = 0;
  return {
    calls: () => n,
    model: {
      async generateText() {
        return "";
      },
      async generateStructured<T>() {
        return answers[Math.min(n++, answers.length - 1)] as T;
      },
    },
  };
};

describe("kampong run with output_schema", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-cli-output-schema-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = async (model: ModelClient) => {
    const path = join(dir, "agent.yaml");
    writeFileSync(path, SPEC);
    const { io, out, err } = capture();
    const code = await runCli(["run", path, "--input", "x", "--json", "--approve-all"], io, {
      model,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("retries a bad answer once, then a condition reads the typed field", async () => {
    const s = scripted([{ severity: "urgent" }, { severity: "high" }]);
    const result = await run(s.model);
    expect(result.code, result.err + result.out).toBe(EXIT_SUCCESS);
    expect(s.calls()).toBe(2);
    expect(JSON.parse(result.out).status).toBe("completed");
  });

  it("fails the run, naming the step and the field, when the retry is wrong too", async () => {
    const s = scripted([{ severity: "urgent" }]);
    const result = await run(s.model);
    expect(result.code).toBe(EXIT_EXECUTION_FAILURE);
    expect(s.calls()).toBe(2);
    expect(result.out + result.err).toMatch(/triage.*output\.severity must be one of low, high/s);
  });
});
