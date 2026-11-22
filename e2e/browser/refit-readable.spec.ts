import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// KAM-295: when the run log takes room from a long workflow, the canvas refits to the first steps at a readable
// size rather than shrinking the whole graph until its cards cannot be read.

const PORT = 4388;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "support-triage");
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-refit-"));
  cpSync(join(TEMPLATE, "agent.yaml"), join(dir, "agent.yaml"));
  cpSync(join(TEMPLATE, "fixtures"), join(dir, "fixtures"), { recursive: true });
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

test.use({ viewport: { width: 1440, height: 900 } });

test("opening the run log keeps the cards readable on a long workflow", async ({ page }) => {
  await page.goto(URL);
  const card = page.locator(".react-flow__node").first();
  await expect(card).toBeVisible();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("run-log")).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(500);
  expect((await card.boundingBox())!.width).toBeGreaterThan(110);
});
