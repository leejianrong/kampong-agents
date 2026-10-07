import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectoryComponentRegistry, type ModelClient } from "@kampong/engine";
import { componentCatalogFor } from "../../src/components.js";
import { createDevServer } from "../../src/server.js";
import { EXIT_EXECUTION_FAILURE, EXIT_SUCCESS, runCli } from "../../src/cli.js";
import { capture } from "../unit/test-helpers.js";

// KAN-1838: a component the registry index revokes is refused by a run, a pin, the doctor, an export
// and the canvas, from the project's own .kampong/registry-index.json as well as the shipped index.

const model: ModelClient = {
  async generateText() {
    return "ok";
  },
  async generateStructured<T>() {
    return { result: {}, confidence: 1 } as T;
  },
};

const SPEC = `version: "1.0"
agent:
  id: a
  name: A
  role: R
  goal: G
  model: { provider: ollama, name: llama3.1 }
  tools:
    - name: greet
      action: component
      use: acme/hello@1.0.0
      op: greet
      with: { who: "{{ input }}" }
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
    input: { type: object, required: [who], properties: { who: { type: string } } }
`;

describe("revoked components", () => {
  let dir: string;
  const spec = () => join(dir, "agent.yaml");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-cli-revoked-"));
    mkdirSync(join(dir, "components/acme/hello/1.0.0"), { recursive: true });
    writeFileSync(join(dir, "components/acme/hello/1.0.0/component.yaml"), MANIFEST);
    writeFileSync(
      join(dir, "components/acme/hello/1.0.0/index.mjs"),
      "export async function invoke(op, input) { return { greeting: 'hi ' + input.who }; }",
    );
    writeFileSync(spec(), SPEC);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const revoke = async (extra = "") => {
    const { digest } = await new DirectoryComponentRegistry(join(dir, "components")).resolve(
      "acme/hello",
      "1.0.0",
    );
    mkdirSync(join(dir, ".kampong"), { recursive: true });
    writeFileSync(
      join(dir, ".kampong/registry-index.json"),
      JSON.stringify({
        version: 1,
        components: [
          {
            id: "acme/hello",
            version: "1.0.0",
            digest,
            tier: 2,
            revoked: {
              reason: "it BCCs all mail to an attacker",
              at: "2026-10-07",
              ...(extra && { advisory: extra }),
            },
          },
        ],
      }),
    );
  };
  const run = async () => {
    const { io, out, err } = capture();
    const code = await runCli(["run", spec(), "--input", "kai", "--json"], io, { model });
    return { code, text: out.join("\n") + err.join("\n") };
  };

  it("runs before it is revoked, and is refused after, naming the reason", async () => {
    expect(await runCli(["lock", spec()], capture().io)).toBe(EXIT_SUCCESS);
    expect((await run()).code).toBe(EXIT_SUCCESS);
    await revoke("https://example.com/advisory");
    const after = await run();
    expect(after.code).toBe(EXIT_EXECUTION_FAILURE);
    expect(after.text).toContain("was revoked on 2026-10-07");
    expect(after.text).toContain("BCCs all mail");
    expect(after.text).toContain("https://example.com/advisory");
  });

  it("will not pin a revoked component", async () => {
    await revoke();
    const { io, err } = capture();
    expect(await runCli(["lock", spec()], io)).not.toBe(EXIT_SUCCESS);
    expect(err.join("\n")).toContain("was revoked");
  });

  it("makes the doctor fail on it", async () => {
    await runCli(["lock", spec()], capture().io);
    await revoke();
    const { io, out, err } = capture();
    const code = await runCli(["doctor", spec()], io, { env: { ANTHROPIC_API_KEY: "x" } });
    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    expect(out.join("\n") + err.join("\n")).toContain("was revoked");
  });

  it("will not export it", async () => {
    await runCli(["lock", spec()], capture().io);
    await revoke();
    const { io, err } = capture();
    expect(await runCli(["export", spec(), join(dir, "out")], io)).not.toBe(EXIT_SUCCESS);
    expect(err.join("\n")).toContain("was revoked");
  });

  it("marks it in the canvas catalog, and the pin endpoint refuses it", async () => {
    await revoke();
    const catalog = await componentCatalogFor(spec());
    const entry = catalog.components.find((c) => c.id === "acme/hello");
    expect(entry?.revoked?.reason).toContain("BCCs all mail");

    const app = createDevServer({ specPath: spec(), layoutPath: join(dir, "layout.json") });
    try {
      await app.ready();
      const res = await app.inject({
        method: "POST",
        url: "/api/components/pin",
        payload: { use: "acme/hello@1.0.0" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toContain("was revoked");
    } finally {
      await app.close();
    }
  });

  it("applies a revocation added while the process is running", async () => {
    await runCli(["lock", spec()], capture().io);
    const app = createDevServer({ specPath: spec(), layoutPath: join(dir, "layout.json") });
    try {
      await app.ready();
      const before = (await app.inject({ method: "GET", url: "/api/components" })).json();
      expect(
        before.components.find((c: { id: string }) => c.id === "acme/hello").revoked,
      ).toBeUndefined();
      await revoke();
      const after = (await app.inject({ method: "GET", url: "/api/components" })).json();
      expect(
        after.components.find((c: { id: string }) => c.id === "acme/hello").revoked,
      ).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("fails visibly, not open, when the project's index cannot be read", async () => {
    await runCli(["lock", spec()], capture().io);
    mkdirSync(join(dir, ".kampong"), { recursive: true });
    writeFileSync(join(dir, ".kampong/registry-index.json"), "{ not json");
    const result = await run();
    expect(result.code).toBe(EXIT_EXECUTION_FAILURE);
    expect(result.text).toContain("registry index");
  });

  it("does not let a project's index vouch for anything: a non-revoked entry changes nothing", async () => {
    mkdirSync(join(dir, ".kampong"), { recursive: true });
    writeFileSync(
      join(dir, ".kampong/registry-index.json"),
      JSON.stringify({
        version: 1,
        components: [
          { id: "acme/hello", version: "1.0.0", digest: `sha256:${"0".repeat(64)}`, tier: 0 },
        ],
      }),
    );
    // Still needs its pin like any other component.
    expect((await run()).code).toBe(EXIT_EXECUTION_FAILURE);
    await runCli(["lock", spec()], capture().io);
    expect((await run()).code).toBe(EXIT_SUCCESS);
  });
});
