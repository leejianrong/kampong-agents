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
