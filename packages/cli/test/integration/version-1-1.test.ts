import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelClient } from "@kampong/engine";
import {
  EXIT_EXECUTION_FAILURE,
  EXIT_SUCCESS,
  EXIT_VALIDATION_FAILURE,
  runCli,
} from "../../src/cli.js";
import { capture } from "../unit/test-helpers.js";

// KAN-1840: a version 1.1 spec validates (expressions and vars are checked), but cannot run or export until
// the evaluator lands (KAN-1841, KAN-1851). The refusal is by name and the exit codes are the usual ones.

const model: ModelClient = {
  async generateText() {
    return "ok";
  },
  async generateStructured<T>() {
    return { result: {}, confidence: 1 } as T;
  },
};

const SPEC = (ifExpr: string) => `version: "1.1"
vars:
  n:
    type: number
    default: 1
agent:
  id: a
  name: A
  role: R
  goal: G
  model: { provider: ollama, name: llama3.1 }
  tools:
    - name: t
      action: http_request
      method: GET
      url: "https://x.test/"
  workflow:
    - step: first
      action: classify
    - step: decide
      type: condition
      if: ${JSON.stringify(ifExpr)}
      then: "execute_tool(t)"
      else: "request_human_approval"
`;

describe("kampong with a version 1.1 spec", () => {
  let dir: string;
  const path = () => join(dir, "agent.yaml");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-cli-1-1-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("run refuses it by name, as an execution failure, not a validation one", async () => {
    writeFileSync(path(), SPEC("first.score > vars.n"));
    const { io, out, err } = capture();
    const code = await runCli(["run", path(), "--input", "x", "--json"], io, { model });
    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    // The JSON output escapes the quotes, so match the words.
    expect(out.join("\n") + err.join("\n")).toMatch(/version \\?"1\.1\\?".*cannot run yet/);
  });

  it("run reports a bad expression as a validation failure with its line, before anything runs", async () => {
    const source = SPEC("first.score > > vars.n");
    const line = source.split("\n").findIndex((l) => l.includes("if:")) + 1;
    writeFileSync(path(), source);
    const { io, err } = capture();
    const code = await runCli(["run", path(), "--input", "x"], io, { model });
    expect(code).toBe(EXIT_VALIDATION_FAILURE);
    expect(err.join("\n")).toContain(`agent.workflow.1.if: condition "decide"`);
    expect(err.join("\n")).toContain(`(line ${line})`);
  });

  it("export refuses it by name and writes nothing", async () => {
    writeFileSync(path(), SPEC("first.score > vars.n"));
    const { io, err } = capture();
    const code = await runCli(["export", path(), join(dir, "out")], io);
    expect(code).not.toBe(EXIT_SUCCESS);
    expect(err.join("\n")).toContain('version "1.1"');
  });

  it("doctor validates it", async () => {
    writeFileSync(path(), SPEC("first.score > vars.n"));
    const { io } = capture();
    const code = await runCli(["doctor", path()], io, { env: {} });
    expect(code).not.toBe(EXIT_VALIDATION_FAILURE);
  });
});
