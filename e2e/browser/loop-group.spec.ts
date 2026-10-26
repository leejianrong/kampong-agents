import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// KAM-239: market-etl's loop has ten steps, so it opens as one card; Enter or a click opens it into a group with a
// header, and the header's button (a Tab stop) closes it again. Selecting a step inside a closed loop opens it.
// Real browser against `kampong dev`, at 1440x900 and 900x700.

const PORT = 4358;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-loop-"));
  copyFileSync(
    join("packages", "cli", "templates", "market-etl", "agent.yaml"),
    join(dir, "agent.yaml"),
  );
  server = spawn(
    process.execPath,
    [join("packages", "cli", "dist", "cli.js"), "dev", dir, "--port", String(PORT)],
    { stdio: "ignore" },
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
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const card = (page: Page) =>
  page.locator('.react-flow__node[data-id="group:workflow:each_symbol"]');
const body = (page: Page) => page.locator(".react-flow__node.md3-node--nested");

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test.describe(`at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });
    test.beforeEach(async ({ page }) => {
      await page.goto(URL);
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
    });

    test("a loop of ten steps opens as one card that says so, and Enter opens it into a group", async ({
      page,
    }) => {
      await expect(card(page)).toBeVisible();
      await expect(card(page)).toContainText("10 steps");
      await expect(body(page)).toHaveCount(0);

      await card(page).focus();
      await page.keyboard.press("Enter");
      await expect(card(page)).toHaveCount(0);
      await expect(body(page)).toHaveCount(10);
      await expect(page.getByText("Loop · each symbol")).toBeVisible();
    });

    test("the header button collapses an open loop, by click and by keyboard", async ({ page }) => {
      await card(page).click();
      await expect(body(page)).toHaveCount(10);
      const toggle = page.getByTestId("loop-toggle");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");

      // A real mouse click: the button must stay put between press and release.
      await toggle.click();
      await expect(body(page)).toHaveCount(0);
      await expect(card(page)).toBeVisible();

      await card(page).click();
      await expect(body(page)).toHaveCount(10);
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(body(page)).toHaveCount(0);
    });
  });
}
