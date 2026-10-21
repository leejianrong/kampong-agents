import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// The Test Run panel's result block and inputs on the market-etl template: failed items (KAM-189), var values
// (KAM-191) and the Secrets link (KAM-192). The environment holds no keys, so a live run fails every symbol.

const PORT = 4361;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "market-etl");
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-runcards-"));
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

for (const size of [
  { width: 900, height: 700 },
  { width: 1440, height: 900 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test.beforeEach(async ({ page }) => {
      await page.goto(URL);
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      await openPanel(page, "Test Run");
    });

    async function runLive(page: import("@playwright/test").Page) {
      await page
        .getByRole("group", { name: "Run mode" })
        .getByRole("button", { name: "Live" })
        .click();
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await page
        .getByRole("alertdialog", { name: "Run live?" })
        .getByRole("button", { name: "Run live" })
        .click();
    }

    test("KAM-189: a run whose symbols all failed is completed with 3 errors, in a table", async ({
      page,
    }) => {
      await runLive(page);
      await expect(page.getByTestId("run-status")).toContainText("completed with 3 errors", {
        timeout: 20000,
      });
      const rows = page.getByTestId("run-error-row");
      await expect(rows).toHaveCount(3);
      await expect(rows.first()).toContainText("AAPL");
      await expect(rows.first()).toContainText("each_symbol / fetch");
      await expect(rows.first()).toContainText("ALPHAVANTAGE_API_KEY");
    });

    test("KAM-189: the recorded replay finishes with one error, MSFT, which was rate limited", async ({
      page,
    }) => {
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.getByTestId("run-status")).toContainText("completed with 1 error", {
        timeout: 20000,
      });
      const rows = page.getByTestId("run-error-row");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("MSFT");
      await expect(rows.first()).toContainText("each_symbol / fetch");
      await expect(rows.first()).toContainText("rate limit");
    });
  });
}
