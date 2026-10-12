import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSpec } from "@kampong/spec";
import {
  createAgentRun,
  createComponentDispatcher,
  createFirstPartyRegistry,
  InProcessModuleRunner,
  type RunState,
} from "@kampong/engine";
import { exportProject, type ExportComponent } from "@kampong/exporter";
// @ts-expect-error plain .mjs fakes shared with the template's fixture recorder; no type declarations
import { fakeFetch, requests } from "./fixtures/market-etl-network.mjs";

// KAN-1865: exporter behavioural equivalence for the market-etl template. The exported project is
// installed in a clean directory and run as its own Node project, and its outcome and every request it
// makes are compared with the engine's on the same input. No live network: Alpha Vantage, Supabase and
// Slack are answered by the same offline fake (e2e/fixtures/market-etl-network.mjs) in both runs, the
// engine through its fetch seam and the exported project through a `--import` preload that replaces
// fetch. The one model call is answered by a local fake Ollama server.

const SUMMARY = '{"summary":"AAPL moved 4% on the day.","direction":"up"}';
const SECRETS = {
  ALPHAVANTAGE_API_KEY: "e2e-alpha-vantage-key",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_KEY: "e2e-supabase-key",
  SLACK_BOT_TOKEN: "xoxb-e2e-slack-token",
};
const TEMPLATE = readFileSync(
  fileURLToPath(new URL("../packages/cli/templates/market-etl/agent.yaml", import.meta.url)),
  "utf8",
);
const PRELOAD = fileURLToPath(new URL("./fixtures/market-etl-preload.mjs", import.meta.url));

interface Seen {
  service: string;
  method: string;
  url: string;
  body?: string;
}

interface RunOutcome {
  success: boolean;
  status: string;
  output?: Record<string, unknown>;
  skipped?: { step: string; reason: string };
  trace: unknown[];
}

const toOutcome = (state: RunState): RunOutcome => ({
  success: state.status === "completed",
  status: state.status,
  output: state.finalOutput,
  ...(state.skipped && { skipped: state.skipped }),
  trace: state.trace,
});

function startFakeOllama(replyText: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.includes("/chat/completions")) {
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
      resolvePromise({
        port: typeof address === "object" && address ? address.port : 0,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function run(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npm", args, { cwd, env, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ stdout, stderr, code: code ?? -1 }));
  });
}

const normalise = (log: Seen[]) =>
  log.map(({ service, method, url, body }) => ({ service, method, url, body }));

describe("market-etl template: exported project behavioural equivalence (KAN-1865)", () => {
  let ollama: { port: number; close: () => Promise<void> };
  let exportDir: string;
  let logDir: string;

  beforeEach(async () => {
    ollama = await startFakeOllama(SUMMARY);
    exportDir = mkdtempSync(join(tmpdir(), "kampong-e2e-market-etl-"));
    logDir = mkdtempSync(join(tmpdir(), "kampong-e2e-market-etl-log-"));
  });
  afterEach(async () => {
    await ollama.close();
    rmSync(exportDir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  });

  it("an exported market-etl writes the same rows, isolates the rate-limited symbol and fires the threshold branch exactly as the engine does", async () => {
    const source = TEMPLATE.replace(
      "    provider: ollama\n    name: llama3.1\n",
      `    provider: ollama\n    name: llama3.1\n    base_url: "http://127.0.0.1:${ollama.port}"\n`,
    );
    expect(source).not.toBe(TEMPLATE);
    const { success, spec, errors } = parseSpec(source);
    expect(success, JSON.stringify(errors)).toBe(true);

    // Each case: the vars given, and what the run must do.
    const cases = [
      {
        name: "default threshold: AAPL alerts, NVDA does not, MSFT is rate-limited",
        flags: ["--var", "symbols=AAPL,MSFT,NVDA"],
        vars: { symbols: ["AAPL", "MSFT", "NVDA"] },
        rows: ["AAPL", "NVDA"],
        alerts: 1,
        errors: ["MSFT"],
      },
      {
        name: "a threshold nothing reaches: rows are written and nothing is posted",
        flags: ["--var", "symbols=AAPL,NVDA", "--var", "threshold=50"],
        vars: { symbols: ["AAPL", "NVDA"], threshold: 50 },
        rows: ["AAPL", "NVDA"],
        alerts: 0,
        errors: [],
      },
    ];

    // The engine, with the first-party components, against the offline fake.
    const registry = createFirstPartyRegistry();
    const componentRefs = [
      ["kampong/alpha-vantage", "1.0.0"],
      ["kampong/supabase", "1.0.0"],
      ["kampong/slack", "1.0.0"],
    ] as const;
    const expected: { outcome: RunOutcome; log: ReturnType<typeof normalise> }[] = [];
    const saved = Object.fromEntries(Object.keys(SECRETS).map((k) => [k, process.env[k]]));
    Object.assign(process.env, SECRETS);
    try {
      for (const c of cases) {
        requests.length = 0;
        const state = await createAgentRun(spec!, {
          fetchImpl: fakeFetch,
          components: createComponentDispatcher({
            registry,
            runner: new InProcessModuleRunner(registry),
          }),
          vars: c.vars,
        }).start("");
        expect(state.status, state.error).toBe("completed");
        const loop = state.finalOutput?.each_symbol as {
          results: { row: { record: { symbol: string } } }[];
          errors: { item: string; step: string }[];
        };
        expect(
          loop.results.map((r) => r.row.record.symbol),
          c.name,
        ).toEqual(c.rows);
        expect(
          loop.errors.map((e) => `${e.item}@${e.step}`),
          c.name,
        ).toEqual(c.errors.map((item) => `${item}@fetch`));
        const log = normalise(requests as Seen[]);
        // The rows written are exactly the symbols that loaded: no partial row for the failed one.
        expect(
          log
            .filter((r) => r.service === "supabase")
            .flatMap((r) => JSON.parse(r.body!) as { symbol: string }[])
            .map((row) => row.symbol),
          c.name,
        ).toEqual(c.rows);
        expect(
          log.filter((r) => r.service === "slack"),
          c.name,
        ).toHaveLength(c.alerts);
        expected.push({ outcome: toOutcome(state), log });
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    // Export with the components resolved from the registry, install and run it as its own project.
    const components: ExportComponent[] = [];
    for (const [id, version] of componentRefs) {
      const resolved = await registry.resolve(id, version);
      components.push({
        manifest: resolved.manifest,
        digest: resolved.digest,
        files: Object.fromEntries(resolved.files ?? []),
      });
    }
    exportProject(spec!, exportDir, { components });
    const install = await run(["install", "--no-audit", "--no-fund"], exportDir);
    expect(install.code, `npm install failed:\n${install.stdout}\n${install.stderr}`).toBe(0);
    const typecheck = await run(["run", "typecheck"], exportDir);
    expect(typecheck.code, `typecheck failed:\n${typecheck.stdout}\n${typecheck.stderr}`).toBe(0);

    for (const [i, c] of cases.entries()) {
      const logPath = join(logDir, `requests-${i}.json`);
      const start = await run(
        ["start", "--silent", "--", "--input", "", "--json", ...c.flags],
        exportDir,
        {
          ...process.env,
          ...SECRETS,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${PRELOAD}`.trim(),
          MARKET_ETL_REQUEST_LOG: logPath,
        },
      );
      expect(start.code, `npm start failed:\n${start.stdout}\n${start.stderr}`).toBe(0);
      const line = start.stdout.split("\n").find((l) => l.trim().startsWith("{"));
      expect(line, `expected one JSON line on stdout, got:\n${start.stdout}`).toBeDefined();
      expect(JSON.parse(line!) as RunOutcome, c.name).toEqual(expected[i]!.outcome);
      // The same requests, in the same order, with the same rows and Slack text; no secret in the outcome.
      expect(normalise(JSON.parse(readFileSync(logPath, "utf8")) as Seen[]), c.name).toEqual(
        expected[i]!.log,
      );
      expect(line).not.toContain(SECRETS.ALPHAVANTAGE_API_KEY);
      expect(line).not.toContain(SECRETS.SLACK_BOT_TOKEN);
    }
  }, 300_000);
});
