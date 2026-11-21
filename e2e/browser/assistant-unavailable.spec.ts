import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// KAM-282: a workflow whose model is a local Ollama that is not running must not offer an assistant that then fails.
// The step rail's button is off and says why in plain words, with no environment variable in the main text.

const PORT = 4381;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "support-triage");
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-assistant-off-"));
  cpSync(join(TEMPLATE, "agent.yaml"), join(dir, "agent.yaml"));
  cpSync(join(TEMPLATE, "fixtures"), join(dir, "fixtures"), { recursive: true });
  // No assistant settings, and the workflow's model is a local Ollama on a port nothing listens on.
  server = spawn(
    process.execPath,
    [join("packages", "cli", "dist", "cli.js"), "dev", dir, "--port", String(PORT)],
    { stdio: "ignore", env: { PATH: process.env["PATH"] ?? "", HOME: dir } },
  );
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("kampong dev did not start");
});

test.afterAll(() => {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
});

for (const size of [
  { width: 900, height: 700 },
  { width: 1440, height: 900 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test("the assistant's button is off and says why, in words that name no variable", async ({
      page,
    }) => {
      await page.goto(URL);
      const button = page.getByRole("button", { name: /Build with the assistant|^Assistant$/ });
      await expect(button.first()).toBeDisabled({ timeout: 20000 });
      await expect(button.first()).toHaveAttribute("title", /local model isn't running/);
      // Opened up, the rail says it in the open too.
      const rail = page.getByTestId("assistant-off");
      if (await rail.count()) {
        await expect(rail).toContainText("local model isn't running");
        await expect(rail).not.toContainText(/[A-Z]{3,}_[A-Z_]+/);
      }
    });
  });
}
