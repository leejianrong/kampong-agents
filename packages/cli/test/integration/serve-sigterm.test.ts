import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// A `kampong serve` with a schedule trigger used to ignore SIGTERM for up to the whole schedule interval: the
// service shut down, but a real timer left for the next tick kept the process alive. Ctrl+C looked hung and a
// container was killed by its orchestrator after the grace period. This runs the real built CLI.

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

const SPEC = `version: "1.1"
agent:
  id: ticker
  name: "Ticker"
  role: "R"
  goal: "G"
  trigger:
    type: schedule
    every: 6h
  workflow:
    - step: shape
      type: transform
      set:
        ok: "true"
`;

describe("kampong serve with a schedule", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-serve-sigterm-"));
    writeFileSync(join(dir, "agent.yaml"), SPEC);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("exits promptly on SIGTERM, not at the next tick", async () => {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const child = spawn(
      process.execPath,
      [CLI, "serve", join(dir, "agent.yaml"), "--port", String(port), "--host", "127.0.0.1"],
      { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((resolvePromise) =>
      child.on("close", resolvePromise),
    );
    try {
      for (let i = 0; !output.includes("kampong serve running"); i++) {
        if (i > 100) throw new Error(`kampong serve never started:\n${output}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      const startedAt = Date.now();
      child.kill("SIGTERM");
      const code = await Promise.race([
        exited,
        new Promise<"still running">((r) => setTimeout(() => r("still running"), 10_000)),
      ]);
      expect(code, `still running 10s after SIGTERM:\n${output}`).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
