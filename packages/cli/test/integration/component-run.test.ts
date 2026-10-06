import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelClient } from "@kampong/engine";
import { EXIT_EXECUTION_FAILURE, EXIT_SUCCESS, runCli } from "../../src/cli.js";
import { capture } from "../unit/test-helpers.js";

// KAN-1884: `kampong run` resolves `action: component` tools from a `components/` folder next to the
// spec, runs module ops in-process, and fails visibly when a component cannot be found.

const model: ModelClient = {
  async generateText() {
    return "ok";
  },
  async generateStructured<T>() {
    return { result: {}, confidence: 1 } as T;
  },
};

const SPEC = (use = "acme/hello@1.0.0") => `version: "1.0"
agent:
  id: hello-agent
  name: "Hello"
  role: "Greeter"
  goal: "Greet."
  tools:
    - name: greet
      action: component
      use: ${use}
      op: greet
      with:
        who: "{{ input }}"
  workflow:
    - step: say
      type: tool
      tool: greet
`;

const MANIFEST = `kind: module
id: acme/hello
version: 1.0.0
entry: ./index.mjs
ops:
  greet:
    effect: read
    input:
      type: object
      required: [who]
      properties: { who: { type: string } }
`;

describe("kampong run with a component tool", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-cli-component-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("runs a module op from ./components next to the spec", async () => {
    mkdirSync(join(dir, "components/hello"), { recursive: true });
    writeFileSync(join(dir, "components/hello/component.yaml"), MANIFEST);
    writeFileSync(
      join(dir, "components/hello/index.mjs"),
      "export async function invoke(op, input) { return { greeting: 'hi ' + input.who }; }",
    );
    writeFileSync(join(dir, "agent.yaml"), SPEC());
    const { io, out } = capture();
    const code = await runCli(["run", join(dir, "agent.yaml"), "--input", "kai", "--json"], io, {
      model,
    });
    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.stringify(JSON.parse(out[0]!))).toContain("hi kai");
  });

  it("fails visibly, naming the component, when it is not installed", async () => {
    writeFileSync(join(dir, "agent.yaml"), SPEC());
    const { io, out, err } = capture();
    const code = await runCli(["run", join(dir, "agent.yaml"), "--input", "kai", "--json"], io, {
      model,
    });
    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    expect(out.join("\n") + err.join("\n")).toContain("acme/hello@1.0.0");
  });
});
