import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSpec } from "@kampong/spec";
import { createAgentRun, type RunState } from "@kampong/engine";
import { exportProject } from "@kampong/exporter";

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
  const server: Server = createServer((req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status }));
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
});
