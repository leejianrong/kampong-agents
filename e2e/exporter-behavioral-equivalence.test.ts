import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSpec } from "@kampong/spec";
import {
  createAgentRun,
  createComponentDispatcher,
  createFixtureFetch,
  createModuleFixtures,
  DirectoryComponentRegistry,
  InProcessModuleRunner,
  type RunState,
} from "@kampong/engine";
import { exportProject, type ExportComponent } from "@kampong/exporter";

// SLICES.md V4's headline e2e acceptance test (KAN-1117), the acceptance
// criterion for R4: export a fixture spec, `npm install && npm start` it in
// a clean temp directory with no reference to this repo, and assert its
// output is behaviorally identical to a direct packages/engine run (the
// "canvas/CLI-run" reference) on the same fixed input. Per PLAN.md's
// Testing approach and SLICES.md's own warning, this deliberately does NOT
// cut the corner of only inspecting generated file contents -- it actually
// installs and executes the exported project as a real, separate Node
// project.
//
// "No live network calls" here means the LLM/tool calls specifically, not
// `npm install` itself (which does need real registry access -- expected
// and fine, per SLICES.md/AGENTS.md's own carve-out for this exact test).
// Both the reference run (packages/engine, in-process) and the exported
// project's own run point at the *same* two local fake servers -- a fake
// Ollama-compatible chat-completions endpoint and a fake tool endpoint --
// so both runs are driven by the exact same deterministic canned responses,
// which is what makes a byte-for-byte comparison of their outputs a
// meaningful proof of behavioral equivalence rather than a coincidence.

interface FakeServer {
  port: number;
  requests: number;
  /** The Authorization header of each request the fake tool server received. */
  authorizations?: string[];
  close: () => Promise<void>;
}

function startFakeOllamaServer(replyText: string): Promise<FakeServer> {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.includes("/chat/completions")) {
      requests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-e2e",
          object: "chat.completion",
          created: 1_700_000_000,
          model: "llama3.1",
          choices: [
            { index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({
        port,
        get requests() {
          return requests;
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function startFakeToolServer(status: string): Promise<FakeServer> {
  let requests = 0;
  const authorizations: string[] = [];
  const server: Server = createServer((req, res) => {
    requests++;
    authorizations.push(String(req.headers.authorization ?? ""));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status }));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({
        port,
        authorizations,
        get requests() {
          return requests;
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function buildFixtureSpec(ollamaPort: number, toolPort: number): string {
  return `version: "1.0"
agent:
  id: e2e-charge-agent
  name: "E2E Charge Agent"
  role: "Support"
  goal: "Look up a charge status."
  model:
    provider: ollama
    name: llama3.1
    base_url: "http://127.0.0.1:${ollamaPort}"
  tools:
    - name: check_charge
      action: http_request
      method: GET
      url: "http://127.0.0.1:${toolPort}/charges/{input}"
      extract: "status"
  workflow:
    - step: parse
      action: extract_entities
    - step: decide
      type: condition
      if: "parse.eligible == true"
      then: "x"
      else: "execute_tool(check_charge)"
`;
}

const FIXED_INPUT = "Check charge off-e2e-42";
const OLLAMA_REPLY_TEXT = "parsed: no eligibility signal found";
const TOOL_STATUS = "succeeded";

interface RunOutcome {
  success: boolean;
  status: string;
  output?: Record<string, unknown>;
  trace: unknown[];
}

function toOutcome(state: RunState): RunOutcome {
  return {
    success: state.status === "completed",
    status: state.status,
    output: state.finalOutput,
    trace: state.trace,
  };
}

function runNpm(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npm", args, { cwd, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ stdout, stderr, code: code ?? -1 }));
  });
}

describe("exported project behavioral equivalence (SLICES.md V4, KAN-1117, R4)", () => {
  let ollama: FakeServer;
  let tool: FakeServer;
  let exportDir: string;

  beforeEach(async () => {
    ollama = await startFakeOllamaServer(OLLAMA_REPLY_TEXT);
    tool = await startFakeToolServer(TOOL_STATUS);
    exportDir = mkdtempSync(join(tmpdir(), "kampong-e2e-export-"));
  });

  afterEach(async () => {
    await ollama.close();
    await tool.close();
    rmSync(exportDir, { recursive: true, force: true });
  });

  it("npm install && npm start on the exported project matches the canvas/CLI-run output on the same fixed input", async () => {
    const source = buildFixtureSpec(ollama.port, tool.port);
    const { success, spec } = parseSpec(source);
    expect(success).toBe(true);

    // --- Reference: a direct packages/engine run (what `kampong run` /
    // canvas test-run itself does), against the two local fake servers.
    const referenceRun = createAgentRun(spec!);
    const referenceState = await referenceRun.start(FIXED_INPUT);
    expect(referenceState.status).toBe("completed");
    expect(referenceState.finalOutput?.decide).toBe(TOOL_STATUS);
    const referenceOutcome = toOutcome(referenceState);

    // --- Export: AgentSpec -> standalone project in a clean temp dir with
    // no reference to this repo (ADR-0002, docs/adr/0010).
    const exportResult = exportProject(spec!, exportDir);
    expect(exportResult.files).toContain("package.json");

    // --- Actually install and run it as its own separate Node project.
    const install = await runNpm(["install", "--no-audit", "--no-fund"], exportDir);
    expect(install.code, `npm install failed:\n${install.stdout}\n${install.stderr}`).toBe(0);

    const start = await runNpm(
      ["start", "--silent", "--", "--input", FIXED_INPUT, "--json"],
      exportDir,
    );
    expect(start.code, `npm start failed:\n${start.stdout}\n${start.stderr}`).toBe(0);

    const jsonLine = start.stdout
      .trim()
      .split("\n")
      .find((line) => line.trim().startsWith("{"));
    expect(jsonLine, `expected one JSON line on stdout, got:\n${start.stdout}`).toBeDefined();
    const exportedOutcome = JSON.parse(jsonLine!) as RunOutcome;

    // --- Behavioral equivalence: same status, same final output, same
    // trace -- not a code-shape comparison (PLAN.md's Testing approach).
    expect(exportedOutcome).toEqual(referenceOutcome);

    // Both runs genuinely reached the fake servers (and didn't, say, both
    // trivially fail before ever calling out) -- one call each, from each
    // of the two separate runs.
    expect(ollama.requests).toBe(2);
    expect(tool.requests).toBe(2);
  });

  it("an export that uses a rest and a module component runs them, secrets included, exactly as the engine does", async () => {
    const componentsDir = join(exportDir, "..", `${exportDir.split("/").pop()}-components`);
    const put = (rel: string, content: string) => {
      const full = join(componentsDir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    };
    const host = `127.0.0.1:${tool.port}`;
    const slot = `    token:
      env: E2E_COMPONENT_TOKEN
      hosts: ["${host}"]`;
    put(
      "acme/charges/1.0.0/component.yaml",
      `kind: rest
id: acme/charges
version: 1.0.0
permissions: { egress: ["${host}"] }
auth:
  slots:
${slot}
      inject: { header: Authorization, template: "Bearer {{ secret }}" }
ops:
  get:
    effect: read
    input: { type: object, required: [id], properties: { id: { type: string } } }
    request:
      method: GET
      url: "http://${host}/charges/{{ input.id }}"
`,
    );
    put(
      "acme/shout/1.0.0/component.yaml",
      `kind: module
id: acme/shout
version: 1.0.0
entry: ./index.mjs
permissions: { egress: ["${host}"] }
auth:
  slots:
${slot}
ops:
  run:
    effect: read
    input: { type: object, required: [status], properties: { status: { type: string } } }
`,
    );
    put(
      "acme/shout/1.0.0/index.mjs",
      `export async function invoke(op, input, ctx) {
  const token = ctx.secrets.get("token");
  const res = await ctx.fetch("http://${host}/confirm", { headers: { Authorization: "Bearer " + token } });
  const body = await res.json();
  return { shouted: input.status.toUpperCase(), confirmed: body.status };
}
`,
    );

    // KAN-1833: a module that uses no network at all, so only the invoke(op) boundary can record it.
    put(
      "acme/stamp/1.0.0/component.yaml",
      `kind: module
id: acme/stamp
version: 1.0.0
entry: ./index.mjs
ops:
  run:
    effect: read
    input: { type: object, required: [text], properties: { text: { type: string } } }
`,
    );
    put(
      "acme/stamp/1.0.0/index.mjs",
      `export async function invoke(op, input) {
  return { stamped: [...input.text].reverse().join("") };
}
`,
    );

    const source = `version: "1.0"
agent:
  id: e2e-component-agent
  name: "E2E Component Agent"
  role: "Support"
  goal: "Look up a charge with components."
  model:
    provider: ollama
    name: llama3.1
    base_url: "http://127.0.0.1:${ollama.port}"
  tools:
    - name: check_charge
      action: component
      use: acme/charges@1.0.0
      op: get
      with: { id: "off-e2e-42" }
      extract: status
    - name: shout
      action: component
      use: acme/shout@1.0.0
      op: run
      with: { status: "{{ charge }}" }
    - name: stamp
      action: component
      use: acme/stamp@1.0.0
      op: run
      with: { text: "{{ charge }}" }
  workflow:
    - step: parse
      action: extract_entities
    - step: charge
      type: tool
      tool: check_charge
    - step: loud
      type: tool
      tool: shout
    - step: stamped
      type: tool
      tool: stamp
`;
    const { success, spec, errors } = parseSpec(source);
    expect(errors).toEqual([]);
    expect(success).toBe(true);

    const previousToken = process.env.E2E_COMPONENT_TOKEN;
    process.env.E2E_COMPONENT_TOKEN = "secret-e2e";
    try {
      // Reference: the engine, with the same components from a directory registry.
      const registry = new DirectoryComponentRegistry(componentsDir);
      const fixturesDir = join(componentsDir, ".fixtures");
      const referenceRun = createAgentRun(spec!, {
        // Record every module op at the invoke(op) boundary as it runs (KAN-1833).
        fetchImpl: createFixtureFetch({ mode: "record", fixturesDir, secrets: ["secret-e2e"] }),
        moduleFixtures: createModuleFixtures({ mode: "record", fixturesDir }),
        components: createComponentDispatcher({
          registry,
          runner: new InProcessModuleRunner(registry),
        }),
      });
      const referenceState = await referenceRun.start(FIXED_INPUT);
      expect(referenceState.status, JSON.stringify(referenceState)).toBe("completed");
      expect(referenceState.finalOutput?.loud).toEqual({
        shouted: "SUCCEEDED",
        confirmed: TOOL_STATUS,
      });
      const referenceOutcome = toOutcome(referenceState);
      const referenceRequests = tool.requests;
      expect(referenceRequests).toBe(2);

      // Replaying those recordings runs no module code (there is no runner) and makes no request (the rest op replays at the HTTP level), yet
      // gives the same outcome, the non-HTTP module included.
      const replayRun = createAgentRun(spec!, {
        fetchImpl: createFixtureFetch({ mode: "replay", fixturesDir }),
        moduleFixtures: createModuleFixtures({ mode: "replay", fixturesDir }),
        components: createComponentDispatcher({ registry }),
      });
      const replayState = await replayRun.start(FIXED_INPUT);
      expect(replayState.status, JSON.stringify(replayState)).toBe("completed");
      expect(toOutcome(replayState)).toEqual(referenceOutcome);
      expect(tool.requests).toBe(referenceRequests);
      expect(referenceState.finalOutput?.stamped).toEqual({
        stamped: [...TOOL_STATUS].reverse().join(""),
      });

      // Export, with the components resolved the way the CLI does it.
      const components: ExportComponent[] = [];
      for (const [id, version] of [
        ["acme/charges", "1.0.0"],
        ["acme/shout", "1.0.0"],
        ["acme/stamp", "1.0.0"],
      ] as const) {
        const resolved = await registry.resolve(id, version);
        components.push({
          manifest: resolved.manifest,
          digest: resolved.digest,
          files: Object.fromEntries(resolved.files ?? []),
        });
      }
      exportProject(spec!, exportDir, { components });

      const install = await runNpm(["install", "--no-audit", "--no-fund"], exportDir);
      expect(install.code, `npm install failed:\n${install.stdout}\n${install.stderr}`).toBe(0);
      const start = await runNpm(
        ["start", "--silent", "--", "--input", FIXED_INPUT, "--json"],
        exportDir,
      );
      expect(start.code, `npm start failed:\n${start.stdout}\n${start.stderr}`).toBe(0);
      const jsonLine = start.stdout
        .trim()
        .split("\n")
        .find((line) => line.trim().startsWith("{"));
      expect(jsonLine, `expected one JSON line on stdout, got:\n${start.stdout}`).toBeDefined();
      const exportedOutcome = JSON.parse(jsonLine!) as RunOutcome;

      expect(exportedOutcome).toEqual(referenceOutcome);
      // Both runs reached the fake server twice (the rest op and the module), each carrying the
      // injected secret; and the secret is nowhere in the outcome.
      expect(tool.requests).toBe(referenceRequests * 2);
      expect(new Set(tool.authorizations)).toEqual(new Set(["Bearer secret-e2e"]));
      expect(JSON.stringify(exportedOutcome)).not.toContain("secret-e2e");

      // KAN-1837: the export carries the records to check it against, and it passes untouched.
      for (const file of ["kampong.lock", "sbom.json"]) {
        expect(existsSync(join(exportDir, file)), file).toBe(true);
      }
      const clean = await runNpm(["run", "verify", "--silent"], exportDir);
      expect(clean.code, `verify failed on a clean export:\n${clean.stdout}\n${clean.stderr}`).toBe(
        0,
      );

      // A tampered module is caught by `npm run verify` and, before any run or request, by startup.
      const tampered = join(exportDir, "components", "acme", "shout", "1.0.0", "index.mjs");
      writeFileSync(tampered, `${readFileSync(tampered, "utf8")}\n// injected\n`);
      const requestsBefore = tool.requests;
      const verify = await runNpm(["run", "verify", "--silent"], exportDir);
      expect(verify.code).not.toBe(0);
      expect(verify.stderr).toContain("acme/shout@1.0.0");
      expect(verify.stderr).toContain("index.mjs was changed");
      const refused = await runNpm(
        ["start", "--silent", "--", "--input", FIXED_INPUT, "--json"],
        exportDir,
      );
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("do not match what was exported");
      expect(tool.requests).toBe(requestsBefore);
    } finally {
      if (previousToken === undefined) delete process.env.E2E_COMPONENT_TOKEN;
      else process.env.E2E_COMPONENT_TOKEN = previousToken;
      rmSync(componentsDir, { recursive: true, force: true });
    }
  }, 240_000);
});
