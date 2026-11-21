import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// KAM-273: the run log's height is the person's to set (drag or keys, and it is remembered), and on a phone the
// open log is a sheet over the canvas with a clear close that gives the canvas back.

const PORT = 4376;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "market-etl");
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-runlog-"));
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

async function runOnce(page: Page) {
  await page.goto(URL);
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("run-log-outcome")).toBeVisible({ timeout: 20000 });
}

const bodyHeight = async (page: Page) =>
  Math.round((await page.locator(".md3-runlog__body").boundingBox())!.height);

test.describe("1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the log's height is set by drag and by key, and is remembered", async ({ page }) => {
    await runOnce(page);
    const before = await bodyHeight(page);
    const bar = (await page.getByTestId("run-log-resizer").boundingBox())!;
    await page.mouse.move(bar.x + 200, bar.y + 4);
    await page.mouse.down();
    await page.mouse.move(bar.x + 200, bar.y - 96, { steps: 5 });
    await page.mouse.up();
    const dragged = await bodyHeight(page);
    expect(dragged).toBeGreaterThan(before + 80);

    await page.getByTestId("run-log-resizer").focus();
    await page.keyboard.press("ArrowDown");
    expect(await bodyHeight(page)).toBe(dragged - 24);

    await runOnce(page);
    expect(await bodyHeight(page)).toBe(dragged - 24);
  });
});

test.describe("390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the open log is a sheet over the canvas, with a header on one line and a Close that restores it", async ({
    page,
  }) => {
    await runOnce(page);
    const log = page.getByTestId("run-log");
    const box = (await log.boundingBox())!;
    expect(box.height).toBeGreaterThan(700);
    const head = (await page.locator(".md3-runlog__head").boundingBox())!;
    expect(head.height).toBeLessThan(64);
    await expect(page.getByRole("button", { name: "Close run log" })).toContainText("Close");

    await page.getByTestId("run-log-toggle").click();
    await expect(log).toHaveAttribute("data-open", "false");
    expect((await log.boundingBox())!.height).toBeLessThan(80);

    await page.getByTestId("run-log-toggle").click();
    await expect(log).toHaveAttribute("data-open", "true");
    await page.keyboard.press("Escape");
    await expect(log).toHaveAttribute("data-open", "false");
  });
});
