import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { createFixtureFetch } from "@kampong/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXIT_EXECUTION_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  EXIT_VALIDATION_FAILURE,
  runCli,
} from "../../src/cli.js";
import { capture } from "../unit/test-helpers.js";

// KAN-1836: `kampong doctor` is a read-only preflight. It exits non-zero when something would stop a
// run, names every problem, and never prints a secret value.

const SECRET = "sk-super-secret-value-123";

const spec = (
  tools: string,
  steps = "- step: go\n      type: tool\n      tool: greet",
) => `version: "1.0"
agent:
  id: doc-agent
  name: "Doc"
  role: "Tester"
  goal: "Test."
  model:
    provider: anthropic
    name: claude-sonnet-5-5
    api_key: \${ANTHROPIC_API_KEY}
  tools:
${tools}
  workflow:
    ${steps}
`;

const HELLO_TOOL = `    - name: greet
      action: component
      use: acme/hello@1.0.0
      op: greet
      with: { who: "x" }`;

const MANIFEST = (extra = "") => `kind: module
id: acme/hello
version: 1.0.0
entry: ./index.mjs
${extra}ops:
  greet:
    effect: read
`;

describe("kampong doctor", () => {
  let dir: string;
  const path = (f: string) => join(dir, f);
  const install = (manifest: string, code: string) => {
    mkdirSync(path("components/acme/hello/1.0.0"), { recursive: true });
    writeFileSync(path("components/acme/hello/1.0.0/component.yaml"), manifest);
    writeFileSync(path("components/acme/hello/1.0.0/index.mjs"), code);
  };
  const OK_CODE = "export async function invoke() { return {}; }";
  const doctor = async (args: string[], env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: SECRET }) => {
    const { io, out, err } = capture();
    const code = await runCli(["doctor", ...args], io, { env });
    return { code, text: out.join("\n") + "\n" + err.join("\n") };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-doctor-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes a spec whose component is pinned and whose key is set, without printing the key", async () => {
    install(MANIFEST(), OK_CODE);
    writeFileSync(path("agent.yaml"), spec(HELLO_TOOL));
    expect(await runCli(["lock", path("agent.yaml")], capture().io)).toBe(EXIT_SUCCESS);
    const { code, text } = await doctor([path("agent.yaml")]);
    expect(code).toBe(EXIT_SUCCESS);
    expect(text).toContain("acme/hello@1.0.0");
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).not.toContain(SECRET);
  });

  it("fails on a missing model key, naming the variable", async () => {
    writeFileSync(
      path("agent.yaml"),
      spec("    []", "- step: go\n      type: action\n      action: x"),
    );
    const { code, text } = await doctor([path("agent.yaml")], {});
    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    expect(text).toMatch(/ANTHROPIC_API_KEY.*not set/);
  });

  it("fails when a used component is not installed", async () => {
    writeFileSync(path("agent.yaml"), spec(HELLO_TOOL));
    const { code, text } = await doctor([path("agent.yaml")]);
    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    expect(text).toContain("acme/hello@1.0.0");
  });

  it("fails on a component that is not pinned", async () => {
    install(MANIFEST(), OK_CODE);
    writeFileSync(path("agent.yaml"), spec(HELLO_TOOL));
    const { code, text } = await doctor([path("agent.yaml")]);
    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    expect(text).toMatch(/not pinned/);
  });

  it("fails on a stale pin and lists what the component may now do beyond what was pinned", async () => {
    install(MANIFEST(), OK_CODE);
    writeFileSync(path("agent.yaml"), spec(HELLO_TOOL));
    await runCli(["lock", path("agent.yaml")], capture().io);
    install(MANIFEST("permissions: { env: [TZ] }\n"), OK_CODE);
    const { code, text } = await doctor([path("agent.yaml")]);
    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    expect(text).toMatch(/changed since it was pinned/);
    expect(text).toContain("env adds TZ");
  });

  it("fails on a module that breaks its static check", async () => {
    install(MANIFEST(), "export async function invoke() { return process.env; }");
    writeFileSync(path("agent.yaml"), spec(HELLO_TOOL));
    const { code, text } = await doctor([path("agent.yaml")]);
    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    expect(text).toMatch(/process/);
  });

  it("reports a secret slot whose environment variable is unset, honouring the spec's remap", async () => {
    const manifest = `kind: rest
id: acme/api
version: 1.0.0
permissions: { egress: [api.example.com] }
auth:
  slots:
    token:
      env: ACME_TOKEN
      hosts: [api.example.com]
      inject: { header: Authorization, template: "Bearer {{ secret }}" }
ops:
  ping:
    effect: read
    request: { method: GET, url: "https://api.example.com/ping" }
`;
    mkdirSync(path("components/acme/api/1.0.0"), { recursive: true });
    writeFileSync(path("components/acme/api/1.0.0/component.yaml"), manifest);
    const tool = (secrets: string) => `    - name: greet
      action: component
      use: acme/api@1.0.0
      op: ping
${secrets}`;
    writeFileSync(path("agent.yaml"), spec(tool("")));
    await runCli(["lock", path("agent.yaml")], capture().io);
    const plain = await doctor([path("agent.yaml")]);
    expect(plain.code).toBe(EXIT_EXECUTION_FAILURE);
    expect(plain.text).toContain("ACME_TOKEN");
    // A remap points the slot at another variable, and that is the one that must be set.
    writeFileSync(path("agent.yaml"), spec(tool('      secrets: { token: "${OTHER_TOKEN}" }')));
    const remapped = await doctor([path("agent.yaml")], {
      ANTHROPIC_API_KEY: SECRET,
      ACME_TOKEN: "set-but-not-the-one-used",
    });
    expect(remapped.code).toBe(EXIT_EXECUTION_FAILURE);
    expect(remapped.text).toContain("OTHER_TOKEN");
    const ok = await doctor([path("agent.yaml")], { ANTHROPIC_API_KEY: SECRET, OTHER_TOKEN: "t" });
    expect(ok.code).toBe(EXIT_SUCCESS);
  });

  it("checks the credential of a legacy Slack tool without needing a pin", async () => {
    const tool = `    - name: greet
      action: slack_post_message
      token: \${SLACK_TOKEN}
      channel: "#x"
      text: hi`;
    writeFileSync(path("agent.yaml"), spec(tool));
    const missing = await doctor([path("agent.yaml")]);
    expect(missing.code).toBe(EXIT_EXECUTION_FAILURE);
    expect(missing.text).toContain("SLACK_TOKEN");
    expect(missing.text).not.toMatch(/not pinned/);
    const ok = await doctor([path("agent.yaml")], { ANTHROPIC_API_KEY: SECRET, SLACK_TOKEN: "x" });
    expect(ok.code).toBe(EXIT_SUCCESS);
  });

  it("finds ${ENV} references inside an http_request tool", async () => {
    const tool = `    - name: greet
      action: http_request
      method: GET
      url: https://api.example.com/x
      headers: { Authorization: "Bearer \${API_TOKEN}" }`;
    writeFileSync(path("agent.yaml"), spec(tool));
    const { code, text } = await doctor([path("agent.yaml")]);
    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    expect(text).toContain("API_TOKEN");
  });

  it("an ollama model needs no key", async () => {
    const ollama = spec("    []", "- step: go\n      type: action\n      action: x")
      .replace("provider: anthropic", "provider: ollama")
      .replace("    api_key: ${ANTHROPIC_API_KEY}\n", "");
    writeFileSync(path("agent.yaml"), ollama);
    expect((await doctor([path("agent.yaml")], {})).code).toBe(EXIT_SUCCESS);
  });

  it("with --tools replay, fails for a tool with no recorded fixture", async () => {
    const tool = `    - name: greet
      action: http_request
      method: GET
      url: https://api.example.com/x`;
    writeFileSync(path("agent.yaml"), spec(tool));
    const missing = await doctor([path("agent.yaml"), "--tools", "replay"]);
    expect(missing.code).toBe(EXIT_EXECUTION_FAILURE);
    expect(missing.text).toContain("greet");
    mkdirSync(path(".kampong/fixtures"), { recursive: true });
    writeFileSync(path(".kampong/fixtures/greet.0123456789abcdef.json"), "{}");
    expect((await doctor([path("agent.yaml"), "--tools", "replay"])).code).toBe(EXIT_SUCCESS);
  });

  it("recognises the file name the fixture recorder really writes, for odd tool names and components", async () => {
    const fixturesDir = path(".kampong/fixtures");
    const record = createFixtureFetch({
      mode: "record",
      fixturesDir,
      fetchImpl: async () =>
        new Response("{}", { headers: { "content-type": "application/json" } }),
    });
    await record("https://api.example.com/x", {}, { toolName: "my tool/v2" });
    await record("https://api.example.com/y", {}, { toolName: "acme/api.ping" });
    expect(readdirSync(fixturesDir)).toHaveLength(2);
    const tools = `    - name: my tool/v2
      action: http_request
      method: GET
      url: https://api.example.com/x
    - name: ping
      action: component
      use: acme/api@1.0.0
      op: ping`;
    mkdirSync(path("components/acme/api/1.0.0"), { recursive: true });
    writeFileSync(
      path("components/acme/api/1.0.0/component.yaml"),
      `kind: rest
id: acme/api
version: 1.0.0
permissions: { egress: [api.example.com] }
ops:
  ping:
    effect: read
    request: { method: GET, url: "https://api.example.com/ping" }
`,
    );
    writeFileSync(path("agent.yaml"), spec(tools));
    await runCli(["lock", path("agent.yaml")], capture().io);
    const { code, text } = await doctor([path("agent.yaml"), "--tools", "replay"]);
    expect(text).not.toContain("no recorded fixture");
    expect(code).toBe(EXIT_SUCCESS);
  });

  it("is offline by default and reaches hosts only with --online", async () => {
    install(
      MANIFEST("permissions: { egress: [api.example.com, '*.wild.example.org'] }\n"),
      OK_CODE,
    );
    writeFileSync(path("agent.yaml"), spec(HELLO_TOOL));
    await runCli(["lock", path("agent.yaml")], capture().io);
    const seen: string[] = [];
    const run = async (args: string[], reachable: boolean) => {
      const { io, out, err } = capture();
      const code = await runCli(["doctor", path("agent.yaml"), ...args], io, {
        env: { ANTHROPIC_API_KEY: SECRET },
        connect: async (host, port) => {
          seen.push(`${host}:${port}`);
          return reachable ? undefined : "connection refused";
        },
      });
      return { code, text: out.join("\n") + err.join("\n") };
    };
    expect((await run([], true)).code).toBe(EXIT_SUCCESS);
    expect(seen).toEqual([]);
    expect((await run(["--online"], true)).code).toBe(EXIT_SUCCESS);
    // A wildcard has no single host to dial; it is not probed.
    expect(seen).toEqual(["api.example.com:443"]);
    const down = await run(["--online"], false);
    expect(down.code).toBe(EXIT_EXECUTION_FAILURE);
    expect(down.text).toContain("connection refused");
  });

  it("exits with the validation code on an invalid spec and the usage code on bad arguments", async () => {
    writeFileSync(path("agent.yaml"), "version: nope");
    expect((await doctor([path("agent.yaml")])).code).toBe(EXIT_VALIDATION_FAILURE);
    expect((await doctor([])).code).toBe(EXIT_USAGE_ERROR);
    expect((await doctor([path("agent.yaml"), "--bogus"])).code).toBe(EXIT_USAGE_ERROR);
  });

  it("supports --json with one parseable object", async () => {
    writeFileSync(
      path("agent.yaml"),
      spec("    []", "- step: go\n      type: action\n      action: x"),
    );
    const { io, out } = capture();
    const code = await runCli(["doctor", path("agent.yaml"), "--json"], io, { env: {} });
    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    const parsed = JSON.parse(out.join("")) as { ok: boolean; checks: { status: string }[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.some((c) => c.status === "fail")).toBe(true);
  });

  describe("review findings", () => {
    const agent = (tools: string) => spec(tools, "- step: go\n      type: action\n      action: x");
    it("fails when a cloud model has no usable key, and ignores a stray key on ollama", async () => {
      writeFileSync(
        path("agent.yaml"),
        agent("    []").replace("    api_key: ${ANTHROPIC_API_KEY}\n", ""),
      );
      const noKey = await doctor([path("agent.yaml")]);
      // The schema rejects it first, as a run would.
      expect(noKey.code).toBe(EXIT_VALIDATION_FAILURE);
      writeFileSync(
        path("agent.yaml"),
        agent("    []").replace("provider: anthropic", "provider: ollama"),
      );
      const ollama = await doctor([path("agent.yaml")], {});
      expect(ollama.code).toBe(EXIT_SUCCESS);
      expect(ollama.text).not.toContain("ANTHROPIC_API_KEY");
    });

    it("fails when the spec has no model at all", async () => {
      const noModel = agent("    []").replace(/ {2}model:\n( {4}.*\n){3}/, "");
      writeFileSync(path("agent.yaml"), noModel);
      const { code, text } = await doctor([path("agent.yaml")], {});
      expect(code).toBe(EXIT_EXECUTION_FAILURE);
      expect(text).toContain("agent.model is not configured");
    });

    it("does not read ${VAR} from a tool's name or non-request fields", async () => {
      const tool = `    - name: greet
      action: http_request
      method: GET
      url: https://api.example.com/x
      extract: "$.\${NOT_AN_ENV_REF}"`;
      writeFileSync(path("agent.yaml"), agent(tool));
      const { code, text } = await doctor([path("agent.yaml")]);
      expect(text).not.toContain("NOT_AN_ENV_REF");
      expect(code).toBe(EXIT_SUCCESS);
    });

    it("reports a malformed tool URL as a failed check instead of crashing", async () => {
      const tool = `    - name: greet
      action: http_request
      method: GET
      url: "http://[bad"`;
      writeFileSync(path("agent.yaml"), agent(tool));
      const { code, text } = await doctor([path("agent.yaml")]);
      expect(code).toBe(EXIT_EXECUTION_FAILURE);
      expect(text).toContain("not a valid URL");
    });

    it("rejects a --fixtures value that is really the next flag", async () => {
      writeFileSync(path("agent.yaml"), agent("    []"));
      expect((await doctor([path("agent.yaml"), "--fixtures", "--json"])).code).toBe(
        EXIT_USAGE_ERROR,
      );
    });

    it("only warns, in replay, about a module op that makes no request", async () => {
      install(MANIFEST(), OK_CODE);
      writeFileSync(path("agent.yaml"), spec(HELLO_TOOL));
      await runCli(["lock", path("agent.yaml")], capture().io);
      const { code, text } = await doctor([path("agent.yaml"), "--tools", "replay"]);
      expect(code).toBe(EXIT_SUCCESS);
      expect(text).toContain("no recorded fixture");
    });

    it("dials a templated egress host once the tool's config fills it in", async () => {
      const manifest = `kind: rest
id: acme/api
version: 1.0.0
permissions: { egress: ["{{ config.sub }}.example.com"] }
config:
  sub: { type: string }
ops:
  ping:
    effect: read
    request: { method: GET, url: "https://{{ config.sub }}.example.com/ping" }
`;
      mkdirSync(path("components/acme/api/1.0.0"), { recursive: true });
      writeFileSync(path("components/acme/api/1.0.0/component.yaml"), manifest);
      const tool = `    - name: greet
      action: component
      use: acme/api@1.0.0
      op: ping
      config: { sub: team1 }`;
      writeFileSync(path("agent.yaml"), agent(tool));
      await runCli(["lock", path("agent.yaml")], capture().io);
      const seen: string[] = [];
      const { io } = capture();
      await runCli(["doctor", path("agent.yaml"), "--online"], io, {
        env: { ANTHROPIC_API_KEY: SECRET },
        connect: async (host, port) => {
          seen.push(`${host}:${port}`);
          return undefined;
        },
      });
      expect(seen).toContain("team1.example.com:443");
    });
  });
});
