import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
let originalSpec: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-runcards-"));
  cpSync(join(TEMPLATE, "agent.yaml"), join(dir, "agent.yaml"));
  cpSync(join(TEMPLATE, "fixtures"), join(dir, "fixtures"), { recursive: true });
  originalSpec = readFileSync(join(dir, "agent.yaml"), "utf8");
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

    test("KAM-191: vars are listed with their defaults; changing one affects the run, not the spec", async ({
      page,
    }) => {
      const symbols = page.getByTestId("run-var-symbols");
      const threshold = page.getByTestId("run-var-threshold");
      await expect(symbols).toHaveValue("AAPL, MSFT, NVDA");
      await expect(threshold).toHaveValue("1.5");

      // One symbol, so nothing fails: plain green, and AAPL's 4% move is over the 1.5 threshold.
      await symbols.fill("AAPL");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.getByTestId("run-status")).toContainText("completed", { timeout: 20000 });
      await expect(page.getByTestId("run-status")).not.toContainText("error");
      await expect(page.getByTestId("run-errors")).toHaveCount(0);
      await expect(page.getByTestId("run-final-output")).toContainText('"count": 1');
      await expect(page.getByTestId("run-trace")).toContainText("each_symbol[0].summarize");

      // A fresh panel, with the threshold raised above that move: the alert branch is no longer taken.
      await page.reload();
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      await openPanel(page, "Test Run");
      await page.getByTestId("run-var-symbols").fill("AAPL");
      await page.getByTestId("run-var-threshold").fill("50");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.getByTestId("run-status")).toContainText("completed", { timeout: 20000 });
      await expect(page.getByTestId("run-trace")).toContainText("each_symbol[0].delta");
      await expect(page.getByTestId("run-trace")).not.toContainText("each_symbol[0].summarize");

      // The spec is untouched: a fresh canvas shows the defaults again, and so does its file.
      expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(originalSpec);
      await page.reload();
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      await openPanel(page, "Test Run");
      await expect(page.getByTestId("run-var-symbols")).toHaveValue("AAPL, MSFT, NVDA");
      await expect(page.getByTestId("run-var-threshold")).toHaveValue("1.5");
    });

    test("KAM-191: a value of the wrong type fails the run and names the var", async ({ page }) => {
      await page.getByTestId("run-var-threshold").fill("high");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.getByTestId("run-halted")).toContainText("threshold", { timeout: 20000 });
    });
  });
}
