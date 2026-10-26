import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openLoops, openPanel } from "./harness/bars.js";

// KAM-219: the Run bar. Replay is the default when fixtures exist and needs no key; Run works with every panel
// closed; a run that carried failed items on is a warning, not a success; the runs drawer keeps this session's
// runs; and opening Secrets from Test Run does not cost the result.

const PORT = 4364;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "market-etl");
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-runcontrols-"));
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
      await openLoops(page);
    });

    test("runs in Replay from the bar with no panel open, and calls the result a warning", async ({
      page,
    }) => {
      const bar = page.getByTestId("run-controls");
      await expect(
        bar.getByRole("group", { name: "Run mode" }).getByRole("button", { name: "Replay" }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(bar.getByTestId("run-mode-badge")).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Test Run" })).toHaveCount(0);

      await bar.getByTestId("run-button").click();
      // The template's recorded answer for MSFT is a rate limit, so one item fails and the loop carries on.
      await expect(bar.getByTestId("runbar-status")).toContainText("completed with 1 error", {
        timeout: 20000,
      });
      await expect(bar.getByTestId("runbar-status")).toContainText(/\d+(\.\d)? s/);
      await expect(
        page.locator('[data-testid="node-run-status"][data-status="passed"]').first(),
      ).toBeVisible();
      await expect(page.locator('[data-status="failed"]')).toHaveCount(1);

      // The chip opens the details.
      await bar.getByTestId("runbar-status").click();
      await expect(page.getByTestId("run-error-row")).toHaveCount(1);
    });

    test("the runs drawer keeps this session's runs and shows an earlier one again", async ({
      page,
    }) => {
      const bar = page.getByTestId("run-controls");
      await bar.getByTestId("run-button").click();
      await expect(bar.getByTestId("runbar-status")).toContainText("completed", { timeout: 20000 });
      await bar.getByTestId("run-button").click();
      await expect(bar.getByTestId("runs-drawer-toggle")).toContainText("2", { timeout: 20000 });

      await bar.getByTestId("runs-drawer-toggle").click();
      const rows = page.getByTestId("runs-drawer").getByTestId("run-row");
      await expect(rows).toHaveCount(2);
      await expect(rows.first()).toContainText("Replay");
      await rows.last().click();
      await expect(page.getByTestId("runs-drawer")).toHaveCount(0);
      await expect(page.getByTestId("run-earlier")).toBeVisible();
    });

    test("Run is a command, and Live asks first", async ({ page }) => {
      await page.keyboard.press("Control+k");
      await page.getByRole("combobox", { name: "Search commands" }).fill("run the");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("runbar-status")).toContainText("completed", {
        timeout: 20000,
      });

      await page
        .getByRole("group", { name: "Run mode" })
        .getByRole("button", { name: "Live" })
        .click();
      await expect(page.getByTestId("run-mode-badge")).toHaveText("LIVE");
      await page.getByTestId("run-button").click();
      await expect(page.getByRole("alertdialog", { name: "Run live?" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(page.getByTestId("run-button")).toBeFocused();
    });

    test("opening Secrets from Test Run keeps the run result and the typed input", async ({
      page,
    }) => {
      await openPanel(page, "Test Run");
      await page.getByLabel("Input").fill("keep me");
      await page.getByTestId("run-button").click();
      await expect(page.getByTestId("run-status")).toContainText("completed", { timeout: 20000 });

      await openPanel(page, "Secrets");
      await expect(page.getByRole("region", { name: "Test Run" })).toHaveCount(0);
      await expect(page.getByTestId("runbar-status")).toContainText("completed");

      await openPanel(page, "Test Run");
      await expect(page.getByTestId("run-status")).toContainText("completed");
      await expect(page.getByLabel("Input")).toHaveValue("keep me");
    });
  });
}
