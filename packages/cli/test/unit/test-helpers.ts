import { Readable } from "node:stream";
import type { CliIO } from "../../src/cli.js";

// Shared by every test/unit CLI test that needs to run `runCli` and inspect
// what it wrote/exited with (cli.test.ts, cli-export.test.ts -- both were
// carrying a near-identical copy of this before, finding #5). Not shared
// with test/integration's own `capture()` (run-command.test.ts): that one
// deliberately wires `stdin: process.stdin` to drive a real interactive-ish
// approval prompt against a real fake server, a different-enough need for a
// cross-module test that it stays its own small helper there.

/**
 * Captures everything a `CliIO` writes, feeding `stdin` from `stdinLines`
 * (each line auto-terminated with `\n`) or, with no lines given, a single
 * empty read (enough for `runCli` calls that never prompt on stdin).
 *
 * Note: `Readable.from(array)` delivers each array element as its own
 * separate chunk, arriving to `readline` across separate microtask ticks --
 * that's *not* how a real piped/non-TTY stdin behaves (a real pipe with
 * `printf 'n\nreason\n' | ...` typically arrives as one single chunk
 * containing both lines already). That difference is exactly what let
 * KAN-1186 (two sequential `rl.question()` calls hanging against piped
 * stdin) go uncaught by every test here that fed multiple `stdinLines` --
 * see `capturePipedStdin` below for a helper that reproduces the real,
 * single-chunk-delivery shape instead.
 */
export function capture(stdinLines: string[] = []): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const stdin = Readable.from(stdinLines.length > 0 ? stdinLines.map((l) => `${l}\n`) : [""]);
  return {
    io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line), stdin },
    out,
    err,
  };
}

/**
 * Like `capture`, but feeds `stdin` as ONE single chunk (`Readable.from`
 * given a one-element array) rather than one chunk per line -- the shape a
 * real piped/non-TTY stdin actually arrives in (e.g.
 * `printf 'n\nreason\n' | kampong run ...`). Regression coverage for
 * KAN-1186: `promptApproval` must never depend on being able to `question()`
 * a second time once this single chunk has already been drained.
 */
export function capturePipedStdin(rawStdin: string): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const stdin = Readable.from([rawStdin]);
  return {
    io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line), stdin },
    out,
    err,
  };
}
