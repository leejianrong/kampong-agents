import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
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
    // `every: 2s` in place of the template's six-hourly cron, so the exported server ticks within the test
    // (the trigger does not change what a run does, so the single-run comparison below is unaffected).
    const source = TEMPLATE.replace(
      "    provider: ollama\n    name: llama3.1\n",
      `    provider: ollama\n    name: llama3.1\n    base_url: "http://127.0.0.1:${ollama.port}"\n`,
    ).replace('    cron: "0 */6 * * *"\n', "    every: 2s\n");
    expect(source).not.toBe(TEMPLATE);
    expect(source).toContain("every: 2s");
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

    // KAM-158: `npm run serve` runs the schedule. The server ticks on its own clock (`every: 2s`), and
    // POST /schedule/run-now starts a run immediately; every run makes the requests the engine's run did.
    const serveLog = join(logDir, "requests-serve.json");
    const port = 20000 + Math.floor(Math.random() * 20000);
    let server: ChildProcess | undefined;
    let serverOutput = "";
    try {
      server = spawn(join(exportDir, "node_modules", ".bin", "tsx"), ["src/server.ts"], {
        cwd: exportDir,
        env: {
          ...process.env,
          ...SECRETS,
          PORT: String(port),
          HOST: "127.0.0.1",
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${PRELOAD}`.trim(),
          MARKET_ETL_REQUEST_LOG: serveLog,
        },
      });
      server.stdout?.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));
      server.stderr?.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));
      const base = `http://127.0.0.1:${port}`;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; ; i++) {
        const up = await fetch(`${base}/healthz`).then(
          (r) => r.ok,
          () => false,
        );
        if (up) break;
        if (i > 150) throw new Error(`the exported server never came up:\n${serverOutput}`);
        await sleep(200);
      }
      const started = await fetch(`${base}/schedule/run-now`, { method: "POST" });
      expect(started.status, serverOutput).toBe(201);
      const { id } = (await started.json()) as { id: string };
      let state: RunState | undefined;
      for (let i = 0; i < 150; i++) {
        state = ((await (await fetch(`${base}/runs/${id}`)).json()) as { state: RunState }).state;
        if (state.status !== "running") break;
        await sleep(200);
      }
      expect(state?.status, serverOutput).toBe("completed");
      // Long enough for at least one tick of the 2s schedule, then stop gracefully so the log is written.
      await sleep(8000);
      const exited = new Promise<void>((r) => server!.once("exit", () => r()));
      server.kill("SIGTERM");
      await exited;
      const seen = normalise(JSON.parse(readFileSync(serveLog, "utf8")) as Seen[]);
      const perRun = expected[0]!.log.length;
      expect(seen.length % perRun, "whole runs only").toBe(0);
      expect(
        seen.length / perRun,
        "run-now plus at least one scheduled tick",
      ).toBeGreaterThanOrEqual(2);
      for (let at = 0; at < seen.length; at += perRun) {
        expect(seen.slice(at, at + perRun)).toEqual(expected[0]!.log);
      }
    } finally {
      server?.kill("SIGKILL");
    }
  }, 360_000);
});
