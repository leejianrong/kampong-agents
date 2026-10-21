import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// KAM-188: Test Run replays the recorded fixtures by default and says so, and a live run is flagged LIVE and
// confirmed before it can change anything. The template's own fixtures are used, with no keys in the
// environment, so a passing replay proves it never needed one.

const PORT = 4358;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "market-etl");
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-runmodes-"));
  cpSync(join(TEMPLATE, "agent.yaml"), join(dir, "agent.yaml"));
  cpSync(join(TEMPLATE, "fixtures"), join(dir, "fixtures"), { recursive: true });
  // No credentials at all: a replay has to work without them.
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

    test("replays by default on the market-etl template, with no keys, and states the mode", async ({
      page,
    }) => {
      const mode = page.getByRole("group", { name: "Run mode" });
      await expect(mode.getByRole("button", { name: "Replay" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page.getByTestId("run-replay-note")).toContainText("recorded fixtures");
      await expect(page.getByTestId("run-live-banner")).toHaveCount(0);

      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.getByTestId("run-mode")).toContainText("Replay (recorded fixtures)");
      await expect(page.getByTestId("run-status")).toContainText("completed", { timeout: 20000 });
      await expect(page.getByTestId("run-final-output")).toContainText("each_symbol");
      await expect(page.getByTestId("run-final-output")).toContainText("AAPL");
    });

    test("Live shows a LIVE banner and the tools it would call, and asks before a side-effecting run", async ({
      page,
    }) => {
      await page
        .getByRole("group", { name: "Run mode" })
        .getByRole("button", { name: "Live" })
        .click();
      const banner = page.getByTestId("run-live-banner");
      await expect(banner).toContainText("LIVE");
      await expect(banner).toContainText("kampong/slack");
      await expect(banner).toContainText("changes things");

      await page.getByRole("button", { name: "Run", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Run live?" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("kampong/slack");
      // Cancel: nothing started, so no run result is shown.
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId("run-status")).toHaveCount(0);
    });
  });
}
