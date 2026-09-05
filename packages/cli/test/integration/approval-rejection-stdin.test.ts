import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Regression coverage for KAN-1186: "kampong run: rejecting a guardrail/
// approval prompt via piped stdin silently hangs and exits 0 instead of
// reporting a rejected run (exit 2)".
//
// This spawns the REAL, built `kampong` binary (dist/cli.js) with a REAL OS
// pipe for stdin -- deliberately not `cli.test.ts`'s in-process `runCli` +
// `Readable.from(...)` stdin fakes. That distinction matters here: a
// `Readable.from([...])` stream (even a single-chunk one) reports end-of-
// input to `readline` differently than a real pipe/socket does -- against
// the *pre-fix* two-`question()` code, a `Readable.from` source makes the
// second `question()` throw `ERR_USE_AFTER_CLOSE` (caught, reported as an
// execution failure -- wrong shape, but not a hang), while a real piped
// stdin leaves that second `question()` awaiting forever with nothing else
// keeping the event loop alive, so the process just exits 0 with no report
// at all. Only a real child process + a real pipe reproduces that exact
// silent-success failure mode, so that's what this test drives.
//
// The approval pause here is a plain `tool.requires_approval` gate (not a
// `confidence_gate`), so the "parse" step only needs an ordinary
// `generateText` call against a fake Ollama-compatible server -- no need to
// fake Mastra's structured-output extraction to get a specific confidence
// value out of a real model provider.

const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

function startFakeOllamaServer(
  replyText: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-approval-stdin-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "llama3.1",
        choices: [
          { index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

function startFakeToolServer(
  status: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status }));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

function buildApprovalSpec(ollamaPort: number, toolPort: number): string {
  return `version: "1.0"
agent:
  id: refund-agent
  name: "Refund Agent"
  role: "Support"
  goal: "Handle refunds."
  model:
    provider: ollama
    name: llama3.1
    base_url: "http://127.0.0.1:${ollamaPort}"
  tools:
    - name: check_charge
      action: http_request
      method: GET
      url: "http://127.0.0.1:${toolPort}/charges/abc"
      extract: "status"
      requires_approval: true
  workflow:
    - step: parse
      action: extract_entities
    - step: check
      type: condition
      if: "parse.eligible == true"
      then: "x"
      else: "execute_tool(check_charge)"
`;
}

/**
 * Spawns the real `kampong run` binary, writes `stdin` as ONE single
 * `write()` (matching how a real `printf '...' | kampong run ...` pipe
 * typically delivers its data as one chunk) then closes stdin, and races
 * the child's exit against a hard timeout -- if the pre-fix hang regresses,
 * this fails the test with a clear message and kills the child, rather than
 * leaving a zombie process and waiting out vitest's own test timeout.
 */
function runWithPipedStdin(
  args: string[],
  stdinText: string,
  timeoutMs = 10_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `kampong run did not exit within ${timeoutMs}ms -- KAN-1186 regression (stdin ` +
            `rejection hang). stdout so far:\n${stdout}\nstderr so far:\n${stderr}`,
        ),
      );
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });

    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

describe("kampong run -- rejecting an approval prompt via real piped stdin (KAN-1186)", () => {
  let dir: string;
  let ollama: { port: number; close: () => Promise<void> };
  let tool: { port: number; close: () => Promise<void> };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kampong-cli-stdin-reject-"));
    ollama = await startFakeOllamaServer("unused");
    tool = await startFakeToolServer("succeeded");
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await ollama.close();
    await tool.close();
  });

  it("an old-style two-line 'n' + reason answer, piped as a single chunk, does not hang and reports a rejected run at exit 2", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, buildApprovalSpec(ollama.port, tool.port));

    // Exactly the bug report's repro: `printf 'n\nsome reason\n' | kampong run ...`.
    const { code, stdout } = await runWithPipedStdin(
      ["run", specPath, "--input", "refund #1", "--json"],
      "n\nsome reason\n",
    );

    expect(code).toBe(2); // EXIT_EXECUTION_FAILURE
    const jsonLine = stdout
      .trim()
      .split("\n")
      .find((line) => line.trim().startsWith("{"));
    expect(jsonLine, `expected one JSON line on stdout, got:\n${stdout}`).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as { success: boolean; status: string; error: string };
    expect(parsed.success).toBe(false);
    expect(parsed.status).toBe("rejected");
  });

  it('a single-chunk "n:<reason>" answer does not hang and carries the reason through the rejected report', async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, buildApprovalSpec(ollama.port, tool.port));

    const { code, stdout } = await runWithPipedStdin(
      ["run", specPath, "--input", "refund #1", "--json"],
      "n:not sure about this one\n",
    );

    expect(code).toBe(2);
    const jsonLine = stdout
      .trim()
      .split("\n")
      .find((line) => line.trim().startsWith("{"));
    expect(jsonLine, `expected one JSON line on stdout, got:\n${stdout}`).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as { success: boolean; status: string; error: string };
    expect(parsed.success).toBe(false);
    expect(parsed.status).toBe("rejected");
    expect(parsed.error).toBe("not sure about this one");
  });

  it("a piped 'y' answer approves and completes without hanging", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, buildApprovalSpec(ollama.port, tool.port));

    const { code, stdout } = await runWithPipedStdin(
      ["run", specPath, "--input", "refund #1", "--json"],
      "y\n",
    );

    expect(code).toBe(0);
    const jsonLine = stdout
      .trim()
      .split("\n")
      .find((line) => line.trim().startsWith("{"));
    expect(jsonLine, `expected one JSON line on stdout, got:\n${stdout}`).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as { success: boolean; status: string };
    expect(parsed.success).toBe(true);
  });
});
