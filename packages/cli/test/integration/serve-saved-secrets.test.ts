import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretStore } from "../../src/secrets.js";

// KAM-307: a value saved from the canvas (`.kampong/secrets.env`) must reach `kampong serve` run in the same
// folder. The audit found the Secrets panel showing "Saved here" while serve refused every request with 401, because
// it read only the process environment. This runs the real built CLI with an EMPTY environment. A value already in
// the environment still wins over a saved one.

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

const SPEC = `version: "1.1"
agent:
  id: hook
  name: "Hook"
  role: "R"
  goal: "G"
  model:
    provider: ollama
    name: unused
  trigger:
    type: webhook
    auth:
      type: bearer
      secret_env: HOOK_TOKEN
  workflow:
    - step: shape
      type: transform
      set:
        ok: "true"
`;

describe("kampong serve uses values saved from the canvas", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-serve-saved-"));
    writeFileSync(join(dir, "agent.yaml"), SPEC);
    mkdirSync(join(dir, ".kampong"));
    writeFileSync(
      join(dir, ".kampong", "secrets.env"),
      `HOOK_TOKEN=${JSON.stringify("saved-token")}\n`,
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function status(env: Record<string, string>, bearer: string): Promise<number> {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const child = spawn(
      process.execPath,
      [CLI, "serve", join(dir, "agent.yaml"), "--port", String(port), "--host", "127.0.0.1"],
      {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env["PATH"] ?? "", ...env },
      },
    );
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr.on("data", (c: Buffer) => (output += c.toString()));
    try {
      for (let i = 0; !output.includes("kampong serve running"); i++) {
        if (i > 100) throw new Error(`kampong serve never started:\n${output}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ a: 1 }),
      });
      return response.status;
    } finally {
      child.kill("SIGKILL");
    }
  }

  it("accepts the saved token with an empty environment", async () => {
    expect(await status({}, "saved-token")).toBe(201);
  }, 30_000);

  it("still refuses a wrong token", async () => {
    expect(await status({}, "not-the-token")).toBe(401);
  }, 30_000);

  it("lets a value in the environment win over a saved one", async () => {
    expect(await status({ HOOK_TOKEN: "env-token" }, "env-token")).toBe(201);
    expect(await status({ HOOK_TOKEN: "env-token" }, "saved-token")).toBe(401);
  }, 60_000);
});

describe("SecretStore.loadMissing", () => {
  it("fills only names the environment does not already hold, and says which", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kampong-load-missing-"));
    try {
      const writer = new SecretStore(dir, {});
      await writer.set("A_TOKEN", "from-file-a");
      await writer.set("B_TOKEN", "from-file-b");
      const env: NodeJS.ProcessEnv = { B_TOKEN: "from-env", EMPTY_ONE: "" };
      const filled = await new SecretStore(dir, env).loadMissing();
      expect(filled).toEqual(["A_TOKEN"]);
      expect(env["A_TOKEN"]).toBe("from-file-a");
      expect(env["B_TOKEN"]).toBe("from-env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
