import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelClient } from "@kampong/engine";
import { parseSpec } from "@kampong/spec";
import { lockComponents } from "../../src/components.js";
import { createServeServer } from "../../src/serve-server.js";
import { EXIT_EXECUTION_FAILURE, EXIT_SUCCESS, EXIT_USAGE_ERROR, runCli } from "../../src/cli.js";
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
    mkdirSync(join(dir, "components/acme/hello/1.0.0"), { recursive: true });
    writeFileSync(join(dir, "components/acme/hello/1.0.0/component.yaml"), MANIFEST);
    writeFileSync(
      join(dir, "components/acme/hello/1.0.0/index.mjs"),
      "export async function invoke(op, input) { return { greeting: 'hi ' + input.who }; }",
    );
    writeFileSync(join(dir, "agent.yaml"), SPEC());
    expect(await runCli(["lock", join(dir, "agent.yaml")], capture().io)).toBe(EXIT_SUCCESS);
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

  it("kampong serve keeps its default components folder when run options pass components: undefined", async () => {
    mkdirSync(join(dir, "components/acme/hello/1.0.0"), { recursive: true });
    writeFileSync(join(dir, "components/acme/hello/1.0.0/component.yaml"), MANIFEST);
    writeFileSync(
      join(dir, "components/acme/hello/1.0.0/index.mjs"),
      "export async function invoke(op, input) { return { greeting: 'hi ' + input.who }; }",
    );
    writeFileSync(join(dir, "agent.yaml"), SPEC());
    expect(await runCli(["lock", join(dir, "agent.yaml")], capture().io)).toBe(EXIT_SUCCESS);
    const app = createServeServer({
      specPath: join(dir, "agent.yaml"),
      run: { createModel: () => model, components: undefined },
    });
    try {
      await app.ready();
      const hook = await app.inject({
        method: "POST",
        url: "/webhook",
        headers: { "content-type": "text/plain" },
        payload: "kai",
      });
      const id = hook.json().id as string;
      let status = "";
      for (let i = 0; i < 100 && status !== "completed" && status !== "failed"; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
        status = (await app.inject({ method: "GET", url: `/runs/${id}` })).json().state?.status;
      }
      expect(status).toBe("completed");
    } finally {
      await app.close();
    }
  });
});

describe("kampong lock and pin enforcement", () => {
  let dir: string;
  const specPath = () => join(dir, "agent.yaml");
  const lockPath = () => join(dir, "kampong.lock");
  const entry = () => join(dir, "components/acme/hello/1.0.0/index.mjs");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-cli-lock-"));
    mkdirSync(join(dir, "components/acme/hello/1.0.0"), { recursive: true });
    writeFileSync(join(dir, "components/acme/hello/1.0.0/component.yaml"), MANIFEST);
    writeFileSync(
      entry(),
      "export async function invoke(op, input) { return { greeting: input.who }; }",
    );
    writeFileSync(specPath(), SPEC());
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = async () => {
    const { io, out, err } = capture();
    const code = await runCli(["run", specPath(), "--input", "kai", "--json"], io, { model });
    return { code, text: out.join("\n") + err.join("\n") };
  };

  it("refuses to run an unpinned component and points at kampong lock", async () => {
    const { code, text } = await run();
    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    expect(text).toMatch(/not pinned/);
    expect(text).toMatch(/kampong lock/);
  });

  it("writes a deterministic lockfile, and a second lock changes nothing", async () => {
    const first = capture();
    expect(await runCli(["lock", specPath()], first.io)).toBe(EXIT_SUCCESS);
    const text = readFileSync(lockPath(), "utf8");
    expect(text).toMatch(/acme\/hello@1\.0\.0/);
    expect(text).toMatch(/sha256:[0-9a-f]{64}/);
    const second = capture();
    expect(await runCli(["lock", specPath()], second.io)).toBe(EXIT_SUCCESS);
    expect(readFileSync(lockPath(), "utf8")).toBe(text);
    expect((await run()).code).toBe(EXIT_SUCCESS);
  });

  it("fails a run when the component changed after it was pinned", async () => {
    await runCli(["lock", specPath()], capture().io);
    writeFileSync(entry(), "export async function invoke() { return { greeting: 'evil' }; }");
    const { code, text } = await run();
    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    expect(text).toMatch(/pinned digest/);
    expect(text).not.toContain("evil");
  });

  it("will not silently re-pin a changed component: lock needs --update, and leaves the file alone without it", async () => {
    await runCli(["lock", specPath()], capture().io);
    const before = readFileSync(lockPath(), "utf8");
    writeFileSync(entry(), "export async function invoke() { return { greeting: 'v2' }; }");
    const refused = capture();
    expect(await runCli(["lock", specPath()], refused.io)).toBe(EXIT_EXECUTION_FAILURE);
    expect(refused.err.join("\n")).toMatch(/--update/);
    expect(readFileSync(lockPath(), "utf8")).toBe(before);

    const updated = capture();
    expect(await runCli(["lock", specPath(), "--update"], updated.io)).toBe(EXIT_SUCCESS);
    expect(readFileSync(lockPath(), "utf8")).not.toBe(before);
    expect((await run()).code).toBe(EXIT_SUCCESS);
  });

  it("pins a first-party component used by name, and a legacy Slack tool needs no pin to run", async () => {
    writeFileSync(
      specPath(),
      `version: "1.0"\nagent:\n  id: a\n  name: A\n  role: R\n  goal: G\n  tools:\n    - name: post\n      action: component\n      use: kampong/slack@1.0.0\n      op: post_message\n      with: { channel: "#x", text: hi }\n  workflow:\n    - step: s\n      type: tool\n      tool: post\n`,
    );
    const { io } = capture();
    expect(await runCli(["lock", specPath()], io)).toBe(EXIT_SUCCESS);
    expect(readFileSync(lockPath(), "utf8")).toMatch(/kampong\/slack@1\.0\.0/);
  });

  it("keeps pins that belong to other specs when it adds one", async () => {
    const other = `version: 1\ncomponents:\n  other/thing@2.0.0:\n    digest: sha256:${"c".repeat(64)}\n`;
    writeFileSync(lockPath(), other);
    await runCli(["lock", specPath()], capture().io);
    const text = readFileSync(lockPath(), "utf8");
    expect(text).toContain("other/thing@2.0.0");
    expect(text).toContain("acme/hello@1.0.0");
  });

  it("writes nothing when a component cannot be resolved", async () => {
    writeFileSync(specPath(), SPEC("acme/missing@1.0.0"));
    const { io, err } = capture();
    expect(await runCli(["lock", specPath()], io)).toBe(EXIT_EXECUTION_FAILURE);
    expect(err.join("\n")).toContain("acme/missing@1.0.0");
    expect(existsSync(lockPath())).toBe(false);
  });

  it("fails visibly on a malformed lockfile, for lock and for run", async () => {
    writeFileSync(lockPath(), "version: 9\n");
    const l = capture();
    expect(await runCli(["lock", specPath()], l.io)).toBe(EXIT_EXECUTION_FAILURE);
    expect(l.err.join("\n")).toMatch(/kampong\.lock/);
    const { code, text } = await run();
    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    expect(text).toMatch(/kampong\.lock/);
  });

  it("reports a spec with no components without creating a lockfile", async () => {
    writeFileSync(
      specPath(),
      `version: "1.0"\nagent:\n  id: a\n  name: A\n  role: R\n  goal: G\n  workflow:\n    - step: s\n      action: answer\n`,
    );
    const { io, out } = capture();
    expect(await runCli(["lock", specPath()], io)).toBe(EXIT_SUCCESS);
    expect(out.join("\n")).toMatch(/no components/i);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("is a usage error without a spec path", async () => {
    expect(await runCli(["lock"], capture().io)).toBe(EXIT_USAGE_ERROR);
  });

  it("leaves no temporary file behind, and two concurrent locks do not lose each other's pins", async () => {
    mkdirSync(join(dir, "components/acme/second/1.0.0"), { recursive: true });
    writeFileSync(
      join(dir, "components/acme/second/1.0.0/component.yaml"),
      MANIFEST.replace("acme/hello", "acme/second"),
    );
    writeFileSync(
      join(dir, "components/acme/second/1.0.0/index.mjs"),
      "export async function invoke() { return 1; }",
    );
    writeFileSync(join(dir, "other.yaml"), SPEC("acme/second@1.0.0"));
    const codes = await Promise.all([
      runCli(["lock", specPath()], capture().io),
      runCli(["lock", join(dir, "other.yaml")], capture().io),
    ]);
    expect(codes).toEqual([EXIT_SUCCESS, EXIT_SUCCESS]);
    const text = readFileSync(lockPath(), "utf8");
    expect(text).toContain("acme/hello@1.0.0");
    expect(text).toContain("acme/second@1.0.0");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("gives a clear error for a use without a version instead of a garbled not-found", async () => {
    const spec = parseSpec(SPEC()).spec!;
    (spec.agent.tools![0] as { use: string }).use = "acme/hello";
    const outcome = await lockComponents(spec, specPath(), { update: false });
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { message: string }).message).toMatch(/id@version/);
  });
});
