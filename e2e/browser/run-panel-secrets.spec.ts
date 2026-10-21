import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// KAM-192: a missing-key error in Test Run or Checks offers "Set it here", which opens the Secrets panel on that
// name, and a webhook trigger's secret is listed there as needed. The spec is market-etl with a GitHub webhook in
// place of its schedule, and the environment holds no keys.

const PORT = 4361;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "market-etl");
const SCHEDULE = 'type: schedule\n    cron: "0 */6 * * *"\n    overlap: skip';
const WEBHOOK =
  "type: webhook\n    preset: github\n    auth:\n      secret_env: GITHUB_WEBHOOK_SECRET";
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-runsecrets-"));
  const yaml = readFileSync(join(TEMPLATE, "agent.yaml"), "utf8");
  expect(yaml).toContain(SCHEDULE);
  writeFileSync(join(dir, "agent.yaml"), yaml.replace(SCHEDULE, WEBHOOK));
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
    });

    test("the webhook trigger's secret is listed in Secrets as needed, not set", async ({
      page,
    }) => {
      await openPanel(page, "Secrets");
      const row = page
        .getByTestId("secrets-list")
        .getByRole("listitem")
        .filter({ hasText: "GITHUB_WEBHOOK_SECRET" });
      await expect(row).toContainText("Needed, not set");
    });

    test("a failed run offers Set it here, which opens Secrets on that name and saves it", async ({
      page,
    }) => {
      await openPanel(page, "Test Run");
      await page
        .getByRole("group", { name: "Run mode" })
        .getByRole("button", { name: "Live" })
        .click();
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await page
        .getByRole("alertdialog", { name: "Run live?" })
        .getByRole("button", { name: "Run live" })
        .click();
      await expect(page.getByTestId("run-status")).toContainText("completed with 3 errors", {
        timeout: 20000,
      });
      await page.getByRole("button", { name: "Set it here" }).click();

      // The Secrets panel is open on that one name, ready for a value.
      const field = page.getByLabel("New value for ALPHAVANTAGE_API_KEY");
      await expect(field).toBeVisible();
      await expect(field).toBeFocused();
      await field.fill("not-a-real-key");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const row = page
        .getByTestId("secrets-list")
        .getByRole("listitem")
        .filter({ hasText: "ALPHAVANTAGE_API_KEY" });
      await expect(row).toContainText("Saved here");

      // Put it back so the other viewport starts with no key.
      await row.getByRole("button", { name: "Remove ALPHAVANTAGE_API_KEY" }).click();
      await expect(row).toContainText("Needed, not set");
    });

    test("Checks offers Set it here for the webhook secret", async ({ page }) => {
      await openPanel(page, "Checks");
      await page.getByRole("button", { name: "Run checks" }).click();
      await page.getByRole("button", { name: "Set it here for GITHUB_WEBHOOK_SECRET" }).click();
      await expect(page.getByLabel("New value for GITHUB_WEBHOOK_SECRET")).toBeFocused();
    });
  });
}
