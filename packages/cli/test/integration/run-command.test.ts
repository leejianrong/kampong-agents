import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_SUCCESS, runCli, type CliIO } from "../../src/cli.js";

// SLICES.md V3 acceptance-adjacent coverage for `kampong run`: exercises the
// REAL production path (no injected-model test seam -- see cli.test.ts's
// unit layer for that) end to end, against a local fake Ollama-compatible
// server, proving the CLI's provider-resolution + fetch wiring actually
// produces a working request (KAN-1112's `.chat()` fix -- see model.ts's
// comment -- was found by exactly this kind of check). Also proves the
// `--tools record`/`--tools replay` flags are correctly wired through to
// the mock/record tool layer (KAN-1111) at the CLI boundary, not just at
// packages/engine's own level (see engine's tool-fixtures integration test).

function capture(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l), stdin: process.stdin },
    out,
    err,
  };
}

function startFakeOllamaServer(
  replyText: string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolvePromise) => {
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "llama3.1",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: replyText },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

describe("kampong run -- full production path against a local fake Ollama server", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-cli-ollama-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the real ollama provider, calls the fake server, and completes -- no injected-model seam used", async () => {
    const { baseUrl, close } = await startFakeOllamaServer("hello from ollama");
    try {
      const specPath = join(dir, "agent.yaml");
      writeFileSync(
        specPath,
        [
          'version: "1.0"',
          "agent:",
          "  id: local-agent",
          '  name: "Local Agent"',
          '  role: "Tester"',
          '  goal: "Say hello using a local model."',
          "  model:",
          "    provider: ollama",
          "    name: llama3.1",
          `    base_url: ${baseUrl}`,
          "  workflow:",
          "    - step: greet",
          "      action: say_hello",
          "",
        ].join("\n"),
      );
      const { io, out } = capture();

      const code = await runCli(["run", specPath, "--input", "hi", "--json"], io);

      expect(code).toBe(EXIT_SUCCESS);
      const parsed = JSON.parse(out[0]!);
      expect(parsed.success).toBe(true);
      expect(parsed.output.greet.text).toBe("hello from ollama");
    } finally {
      await close();
    }
  });
});

describe("kampong run -- --tools record/replay wiring (KAN-1111)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-cli-tools-"));
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const TOOL_SPEC = `version: "1.0"
agent:
  id: charge-checker
  name: "Charge Checker"
  role: "Support"
  goal: "Check a charge status."
  tools:
    - name: check_charge
      action: http_request
      method: GET
      url: "https://api.stripe.test/v1/charges/abc123"
      extract: "data.status"
  workflow:
    - step: parse
      action: extract_entities
    - step: check
      type: condition
      if: "parse.eligible == true"
      then: "x"
      else: "execute_tool(check_charge)"
`;

  it("--tools record calls the (stubbed) global fetch once and writes a fixture file", async () => {
    const fakeGlobalFetch = vi.fn(
      async () => new Response(JSON.stringify({ data: { status: "succeeded" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fakeGlobalFetch);

    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, TOOL_SPEC);
    const fixturesDir = join(dir, "fixtures");
    const { io } = capture();

    const code = await runCli(
      ["run", specPath, "--input", "hi", "--tools", "record", "--fixtures", fixturesDir],
      io,
      {
        model: {
          generateText: async () => "unused",
          generateStructured: async () => ({}) as never,
        },
      },
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(fakeGlobalFetch).toHaveBeenCalledTimes(1);
    expect(readdirSync(fixturesDir).length).toBeGreaterThan(0);
  });

  it("--tools replay reuses a fixture recorded by a prior --tools record run, with zero fetch calls", async () => {
    const fakeGlobalFetch = vi.fn(
      async () => new Response(JSON.stringify({ data: { status: "succeeded" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fakeGlobalFetch);

    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, TOOL_SPEC);
    const fixturesDir = join(dir, "fixtures");
    const testModel = {
      async generateText() {
        return "unused";
      },
      async generateStructured() {
        return {} as never;
      },
    };

    await runCli(
      ["run", specPath, "--input", "hi", "--tools", "record", "--fixtures", fixturesDir],
      capture().io,
      {
        model: testModel,
      },
    );
    expect(fakeGlobalFetch).toHaveBeenCalledTimes(1);

    const { io, out } = capture();
    const code = await runCli(
      ["run", specPath, "--input", "hi", "--tools", "replay", "--fixtures", fixturesDir, "--json"],
      io,
      { model: testModel },
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(fakeGlobalFetch).toHaveBeenCalledTimes(1); // still just the one recording call, never during replay
    const parsed = JSON.parse(out[0]!);
    expect(parsed.output.check).toBe("succeeded");
  });
});
