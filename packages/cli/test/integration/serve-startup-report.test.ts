import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// KAM-308: serving the unmodified templates with an EMPTY environment lists every missing variable (names only)
// and the unreachable local model at start-up, before any request, and prints an address a sender can use.

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const TEMPLATES = fileURLToPath(new URL("../../templates", import.meta.url));

describe("kampong serve start-up report", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-serve-report-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function startup(template: string, extraArgs: string[] = []): Promise<string> {
    cpSync(join(TEMPLATES, template), dir, { recursive: true });
    const port = 21000 + Math.floor(Math.random() * 20000);
    const child = spawn(
      process.execPath,
      [CLI, "serve", join(dir, "agent.yaml"), "--port", String(port), ...extraArgs],
      { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env["PATH"] ?? "" } },
    );
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr.on("data", (c: Buffer) => (output += c.toString()));
    try {
      for (let i = 0; !output.includes("Press Ctrl+C to stop."); i++) {
        if (i > 150) throw new Error(`kampong serve never finished starting:\n${output}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      return output;
    } finally {
      child.kill("SIGKILL");
    }
  }

  it("webhook-triage: lists the unset variables, never prints localhost as 0.0.0.0", async () => {
    const out = await startup("webhook-triage");
    expect(out).toContain("ALERT_WEBHOOK_TOKEN is not set");
    expect(out).toContain("SLACK_BOT_TOKEN is not set");
    expect(out).toMatch(/to fix before the first run/);
    expect(out).toContain("trigger: POST http://localhost:");
    expect(out).not.toContain("0.0.0.0");
    expect(out).toMatch(/another machine/);
  }, 30_000);

  it("market-etl: says when the schedule first runs and lists each missing credential", async () => {
    const out = await startup("market-etl");
    expect(out).toMatch(
      /trigger: schedule, cron 0 \*\/6 \* \* \* \(UTC\); the first run is at \d{4}-\d\d-\d\d \d\d:\d\d/,
    );
    expect(out).not.toContain("trigger: POST http://localhost:" + "/webhook");
    for (const name of [
      "ALPHAVANTAGE_API_KEY",
      "SUPABASE_URL",
      "SUPABASE_KEY",
      "SLACK_BOT_TOKEN",
    ]) {
      expect(out).toContain(`${name} is not set`);
    }
    expect(out).toContain("/schedule/run-now");
  }, 30_000);

  it("names no value, and says nothing is wrong when the host is a specific one", async () => {
    const out = await startup("market-etl", ["--host", "127.0.0.1"]);
    expect(out).toContain("kampong serve running at http://127.0.0.1:");
    expect(out).not.toMatch(/another machine/);
  }, 30_000);
});
