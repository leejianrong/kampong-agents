#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseSpec, type AgentSpec } from "@kampong/spec";
import {
  createAgentRun,
  createFixtureFetch,
  type ModelClient,
  type RunState,
  type ToolFixtureMode,
} from "@kampong/engine";
import { createDevServer } from "./server.js";

// The CLI's real command surface (PLAN.md Shape S5, SLICES.md V3 KAN-1109/
// 1110). `packages/cli/src/index.ts` stays a pure library barrel (imported
// by apps/canvas's tests and, in principle, any future embedder); this file
// is what `package.json`'s `bin` field actually points at, kept separate so
// importing the library never has the side effect of parsing argv or
// starting a server -- only running this file directly (or via the
// installed `kampong` binary) does.
//
// `runCli` is exported and pure-ish (writes go through an injectable `CliIO`
// rather than `process.stdout`/`process.exit` directly) so packages/cli's
// unit tests can assert exit codes and JSON output without spawning a real
// child process (SLICES.md V3 unit test plan: "CLI exit codes are correct
// for success/validation-failure/execution-failure", "CLI output is valid,
// parseable JSON when requested").

export const EXIT_SUCCESS = 0;
export const EXIT_VALIDATION_FAILURE = 1;
export const EXIT_EXECUTION_FAILURE = 2;
// Distinct from the two exit codes above (which describe what the *run*
// did): reserved for "the command itself was invoked wrong" -- bad flags,
// missing required args -- so a CI script can tell "my spec is broken" (1)
// apart from "I typo'd the flag" (64, the traditional BSD sysexits.h
// EX_USAGE code) apart from "the run itself failed" (2).
export const EXIT_USAGE_ERROR = 64;

export interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  stdin: NodeJS.ReadableStream;
}

const defaultIO: CliIO = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
  stdin: process.stdin,
};

const HELP_TEXT = `kampong -- local-first agent-workflow builder CLI

Usage: kampong <command> [options]

Commands:
  dev [dir]                          Start the local dev server: spec-CRUD API, SSE run
                                      stream, and the canvas UI, all at one localhost origin.
  run <spec>.yaml --input "<text>"   Run a spec headlessly -- no server, no browser.

Run "kampong <command> --help" for command-specific options.`;

const DEV_HELP_TEXT = `kampong dev [dir] [options]

Starts the local Fastify server (PLAN.md Shape S5, ADR-0005): a spec-CRUD REST API, an
SSE stream of file-change/run-progress events, and the built canvas UI -- all served from
one http://<host>:<port> origin, so nothing about local dev needs more than one process.

Arguments:
  [dir]                Directory containing the spec + its .kampong/ sidecar (default: ".")

Options:
  --spec <file>         Spec filename within [dir] (default: "agent.yaml")
  --port <n>            Port to listen on (default: 4310)
  --host <host>         Host to bind (default: "localhost")
  -h, --help             Show this help`;

const RUN_HELP_TEXT = `kampong run <spec>.yaml --input "<text>" [options]

Runs a spec headlessly against the execution engine (PLAN.md Shape S3/S5) -- no server,
no browser. Designed to run fully offline (--tools replay + an "ollama" model provider in
the spec) with zero required network calls (AGENTS.md, R3).

Arguments:
  <spec>.yaml            Path to the AgentSpec YAML file to run

Options:
  --input "<text>"       The run's input text (required)
  --json                 Emit one machine-readable JSON object to stdout instead of a
                          human-readable summary
  --tools <mode>         "live" (default: real network calls) | "record" (call live once,
                          save a fixture) | "replay" (never touch the network; read a
                          previously recorded fixture -- a cache miss is an execution
                          failure, never a silent live fallback)
  --fixtures <dir>       Fixture storage directory for --tools record/replay
                          (default: "<spec dir>/.kampong/fixtures")
  --approve-all          Auto-approve every requires_approval / guardrail pause instead of
                          prompting on stdin -- for non-interactive/CI use. Without it, a
                          paused run prompts on stdin exactly like the canvas's approval
                          modal does for a browser test-run.
  -h, --help              Show this help

Exit codes:
  0   the run completed successfully
  1   the spec failed validation (malformed YAML or a schema violation)
  2   the run could not start, failed mid-execution, or was rejected on approval (e.g. a
      missing BYOK key, an unreachable Ollama server, a failed tool call, or an explicit
      rejection)`;

export interface RunCliTestOptions {
  /**
   * Test-only seam (same pattern as `RunManagerOptions.createModel` and
   * `CreateDevServerOptions.run`): injects a fake `ModelClient` into `kampong
   * run` instead of resolving real BYOK/Ollama config, so exit-code and
   * JSON-output correctness (SLICES.md V3's *unit* test plan) is testable
   * with zero network dependency. The real `kampong` binary never passes
   * this -- see the bottom of this file.
   */
  model?: ModelClient;
}

export async function runCli(
  argv: string[],
  io: CliIO = defaultIO,
  testOptions: RunCliTestOptions = {},
): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "dev":
      return runDevCommand(rest, io);
    case "run":
      return runRunCommand(rest, io, testOptions);
    case "-v":
    case "--version":
      io.stdout(getVersion());
      return EXIT_SUCCESS;
    case "-h":
    case "--help":
    case "help":
      io.stdout(HELP_TEXT);
      return EXIT_SUCCESS;
    case undefined:
      io.stderr(HELP_TEXT);
      return EXIT_USAGE_ERROR;
    default:
      io.stderr(`kampong: unknown command "${command}".\n`);
      io.stderr(HELP_TEXT);
      return EXIT_USAGE_ERROR;
  }
}

function getVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// --- kampong dev ------------------------------------------------------

const DEFAULT_PORT = 4310;
const DEFAULT_HOST = "localhost";
const DEFAULT_SPEC_FILENAME = "agent.yaml";

interface DevArgs {
  dir: string;
  specFilename: string;
  port: number;
  host: string;
}

function parseDevArgs(args: string[]): { ok: true; value: DevArgs } | { ok: false; error: string } {
  let dir: string | undefined;
  let specFilename = DEFAULT_SPEC_FILENAME;
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;

  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      switch (arg) {
        case "--spec":
          specFilename = requireValue(args, ++i, "--spec");
          break;
        case "--port":
          port = Number(requireValue(args, ++i, "--port"));
          if (!Number.isInteger(port) || port <= 0) {
            return { ok: false, error: `--port must be a positive integer.` };
          }
          break;
        case "--host":
          host = requireValue(args, ++i, "--host");
          break;
        default:
          if (arg.startsWith("--")) {
            return { ok: false, error: `Unrecognized option "${arg}".` };
          }
          if (dir !== undefined) {
            return { ok: false, error: `Unexpected extra argument "${arg}".` };
          }
          dir = arg;
      }
    }
  } catch (err) {
    // A malformed flag (e.g. --spec with no following value) is a usage
    // error, not an uncaught exception -- see MissingFlagValueError below.
    if (err instanceof MissingFlagValueError) return { ok: false, error: err.message };
    throw err;
  }

  return { ok: true, value: { dir: dir ?? ".", specFilename, port, host } };
}

/**
 * Thrown by `requireValue` when a flag is given without a following value
 * (e.g. `kampong run spec.yaml --input` with nothing after `--input`). Its
 * own type -- rather than a bare `Error` -- so `parseDevArgs`/`parseRunArgs`
 * can catch *this specific* failure and turn it into their normal
 * `{ ok: false, error }` usage-error result (exit 64) instead of letting it
 * escape uncaught to the top-level `.catch()` (which reports it as a
 * generic unexpected error at exit 2 -- see finding #3).
 */
class MissingFlagValueError extends Error {}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) throw new MissingFlagValueError(`${flag} requires a value.`);
  return value;
}

/**
 * Locates the canvas app's built static assets so `kampong dev` can serve
 * them (ADR-0005: one localhost origin, not a separate frontend process).
 * `apps/canvas` is a workspace *dependency* of this package specifically so
 * this resolves through real Node module resolution -- via the
 * `@kampong/canvas-app` package name, not a hardcoded relative path like
 * `../../../apps/canvas/dist` that only happens to work from this repo's
 * exact directory layout and breaks the moment this package is installed
 * standalone (e.g. published, or vendored). `require.resolve` finds
 * `package.json` (present on every workspace package, `exports`-map or not)
 * whether the dependency is a workspace symlink (today) or a real hoisted
 * copy (if this were ever published with it bundled in) -- the *directory*
 * containing that `package.json` is what matters, not how it got there.
 */
function resolveCanvasDistDir(): string {
  const require = createRequire(import.meta.url);
  let pkgPath: string;
  try {
    pkgPath = require.resolve("@kampong/canvas-app/package.json");
  } catch {
    throw new Error(
      "Could not locate the @kampong/canvas-app workspace package. This normally means " +
        "dependencies aren't installed correctly -- run `npm install` from the repo root.",
    );
  }
  const distDir = join(dirname(pkgPath), "dist");
  if (!existsSync(distDir)) {
    throw new Error(
      `Canvas assets not found at ${distDir}. Build them first -- run \`npm run build\` from ` +
        `the repo root (this runs \`vite build\` for apps/canvas as part of the root build).`,
    );
  }
  return distDir;
}

async function runDevCommand(args: string[], io: CliIO): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    io.stdout(DEV_HELP_TEXT);
    return EXIT_SUCCESS;
  }

  const parsed = parseDevArgs(args);
  if (!parsed.ok) {
    io.stderr(`kampong dev: ${parsed.error}\n`);
    io.stderr(DEV_HELP_TEXT);
    return EXIT_USAGE_ERROR;
  }
  const { dir, specFilename, port, host } = parsed.value;

  const specPath = resolve(dir, specFilename);
  const layoutPath = resolve(dir, ".kampong", "layout.json");

  let staticDir: string;
  try {
    staticDir = resolveCanvasDistDir();
  } catch (err) {
    io.stderr(`kampong dev: ${(err as Error).message}`);
    return EXIT_EXECUTION_FAILURE;
  }

  const app = createDevServer({ specPath, layoutPath, staticDir });

  try {
    await app.listen({ port, host });
  } catch (err) {
    io.stderr(`kampong dev: failed to start: ${(err as Error).message}`);
    return EXIT_EXECUTION_FAILURE;
  }

  io.stdout(`kampong dev running at http://${host}:${port}`);
  io.stdout(`  spec:   ${specPath}${existsSync(specPath) ? "" : " (does not exist yet)"}`);
  io.stdout(`  layout: ${layoutPath}`);
  io.stdout("Press Ctrl+C to stop.");

  return new Promise<number>((resolvePromise) => {
    const shutdown = (): void => {
      app
        .close()
        .catch(() => {
          /* best-effort shutdown */
        })
        .finally(() => resolvePromise(EXIT_SUCCESS));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

// --- kampong run --------------------------------------------------------

const TOOL_MODES: readonly ToolFixtureMode[] = ["live", "record", "replay"];

interface RunArgs {
  specPath: string;
  input: string;
  json: boolean;
  toolsMode: ToolFixtureMode;
  fixturesDir?: string;
  approveAll: boolean;
}

function parseRunArgs(args: string[]): { ok: true; value: RunArgs } | { ok: false; error: string } {
  let specPath: string | undefined;
  let input: string | undefined;
  let json = false;
  let toolsMode: ToolFixtureMode = "live";
  let fixturesDir: string | undefined;
  let approveAll = false;

  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      switch (arg) {
        case "--input":
          input = requireValue(args, ++i, "--input");
          break;
        case "--json":
          json = true;
          break;
        case "--tools": {
          const value = requireValue(args, ++i, "--tools");
          if (!TOOL_MODES.includes(value as ToolFixtureMode)) {
            return {
              ok: false,
              error: `--tools must be one of ${TOOL_MODES.join("|")}, got "${value}".`,
            };
          }
          toolsMode = value as ToolFixtureMode;
          break;
        }
        case "--fixtures":
          fixturesDir = requireValue(args, ++i, "--fixtures");
          break;
        case "--approve-all":
          approveAll = true;
          break;
        default:
          if (arg.startsWith("--")) {
            return { ok: false, error: `Unrecognized option "${arg}".` };
          }
          if (specPath !== undefined) {
            return { ok: false, error: `Unexpected extra argument "${arg}".` };
          }
          specPath = arg;
      }
    }
  } catch (err) {
    if (err instanceof MissingFlagValueError) return { ok: false, error: err.message };
    throw err;
  }

  if (!specPath) return { ok: false, error: "Missing required <spec>.yaml argument." };
  if (input === undefined) return { ok: false, error: 'Missing required --input "<text>" flag.' };

  return {
    ok: true,
    value: { specPath: resolve(specPath), input, json, toolsMode, fixturesDir, approveAll },
  };
}

function defaultFixturesDir(specPath: string): string {
  return join(dirname(specPath), ".kampong", "fixtures");
}

const ENV_VAR_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Every resolved BYOK secret currently in play, so the mock/record layer never writes one to a fixture (AGENTS.md's secrets convention). */
function collectSecrets(spec: AgentSpec, env: NodeJS.ProcessEnv): string[] {
  const secrets: string[] = [];
  const apiKey = spec.agent.model?.api_key;
  const match = apiKey ? ENV_VAR_PATTERN.exec(apiKey) : null;
  if (match) {
    const value = env[match[1]!];
    if (value) secrets.push(value);
  }
  return secrets;
}

/**
 * Adapts an injected `CliIO` sink (`(line: string) => void`) into a Node
 * `Writable` stream, for the one place in this file (`readline`) that needs
 * a real stream rather than a per-message callback -- keeps
 * `readline.createInterface` routed through the same injectable `io` every
 * other output in this file already goes through (finding #6), instead of
 * writing straight to `process.stdout`/`process.stderr` and bypassing a
 * caller's custom `CliIO` (e.g. the test suite's `capture()` helper).
 */
function ioWritable(sink: (chunk: string) => void): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      sink(chunk.toString());
      callback();
    },
  });
}

async function promptApproval(
  state: RunState,
  io: CliIO,
  approveAll: boolean,
  json: boolean,
): Promise<{ approved: boolean; reason?: string }> {
  const pending = state.pendingApproval;
  if (!pending) {
    // Unreachable in practice (only called when status === "awaiting_approval"); a defensive fallback beats a crash mid-run.
    return { approved: approveAll };
  }

  if (approveAll) {
    // Always stderr, never stdout: `--json` promises exactly one JSON
    // object on stdout (finding #4), and this diagnostic must not corrupt
    // that stream for a machine consumer piping to e.g. `jq` -- stderr
    // keeps it visible either way.
    io.stderr(
      `[--approve-all] auto-approving "${pending.step}" (${pending.kind}): ${pending.reason}`,
    );
    return { approved: true };
  }

  const rl = createInterface({
    input: io.stdin,
    output: ioWritable(json ? io.stderr : io.stdout),
  });
  try {
    const answer = await rl.question(
      `\nApproval required at step "${pending.step}" (${pending.kind}): ${pending.reason}\nApprove? [y/N]: `,
    );
    const approved = /^y(es)?$/i.test(answer.trim());
    let reason: string | undefined;
    if (!approved) {
      reason = (await rl.question("Reason for rejection (optional): ")).trim() || undefined;
    }
    return { approved, reason };
  } finally {
    rl.close();
  }
}

function reportExecutionFailure(err: unknown, json: boolean, io: CliIO): number {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    io.stdout(JSON.stringify({ success: false, phase: "execution", error: message }));
  } else {
    io.stderr(`kampong run: execution failed: ${message}`);
  }
  return EXIT_EXECUTION_FAILURE;
}

async function runRunCommand(
  args: string[],
  io: CliIO,
  testOptions: RunCliTestOptions = {},
): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    io.stdout(RUN_HELP_TEXT);
    return EXIT_SUCCESS;
  }

  const parsed = parseRunArgs(args);
  if (!parsed.ok) {
    io.stderr(`kampong run: ${parsed.error}\n`);
    io.stderr(RUN_HELP_TEXT);
    return EXIT_USAGE_ERROR;
  }
  const { specPath, input, json, toolsMode, fixturesDir, approveAll } = parsed.value;

  let source: string;
  try {
    source = readFileSync(specPath, "utf8");
  } catch (err) {
    const message = `Could not read spec file at ${specPath}: ${(err as Error).message}`;
    if (json) io.stdout(JSON.stringify({ success: false, phase: "validation", error: message }));
    else io.stderr(`kampong run: ${message}`);
    return EXIT_VALIDATION_FAILURE;
  }

  const { success, spec, errors } = parseSpec(source);
  if (!success || !spec) {
    if (json) {
      io.stdout(JSON.stringify({ success: false, phase: "validation", errors }));
    } else {
      io.stderr(`kampong run: spec validation failed: ${specPath}`);
      for (const e of errors) {
        io.stderr(
          `  ${e.path.join(".") || "(root)"}: ${e.message}${e.line ? ` (line ${e.line})` : ""}`,
        );
      }
    }
    return EXIT_VALIDATION_FAILURE;
  }

  const fetchImpl =
    toolsMode === "live"
      ? undefined
      : createFixtureFetch({
          mode: toolsMode,
          fixturesDir: fixturesDir ?? defaultFixturesDir(specPath),
          secrets: collectSecrets(spec, process.env),
        });

  let run: ReturnType<typeof createAgentRun>;
  try {
    run = createAgentRun(spec, { fetchImpl, model: testOptions.model });
  } catch (err) {
    return reportExecutionFailure(err, json, io);
  }

  let state: RunState;
  try {
    state = await run.start(input);
    while (state.status === "awaiting_approval") {
      const decision = await promptApproval(state, io, approveAll, json);
      state = await run.resume(decision.approved, decision.reason);
    }
  } catch (err) {
    return reportExecutionFailure(err, json, io);
  }

  if (state.status === "completed") {
    if (json) {
      io.stdout(
        JSON.stringify({
          success: true,
          status: state.status,
          output: state.finalOutput,
          trace: state.trace,
        }),
      );
    } else {
      io.stdout("Run completed.");
      io.stdout(JSON.stringify(state.finalOutput, null, 2));
    }
    return EXIT_SUCCESS;
  }

  // status is "rejected" or "failed" (never "running"/"awaiting_approval" -- the loop above only exits once the status leaves "awaiting_approval", and start()/resume() only ever settle on a terminal or paused state).
  if (json) {
    io.stdout(
      JSON.stringify({
        success: false,
        status: state.status,
        error: state.error,
        trace: state.trace,
      }),
    );
  } else {
    io.stderr(`kampong run: run ${state.status}: ${state.error ?? "(no error message)"}`);
  }
  return EXIT_EXECUTION_FAILURE;
}

// --- entry point ----------------------------------------------------------

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `kampong: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exitCode = EXIT_EXECUTION_FAILURE;
    });
}
