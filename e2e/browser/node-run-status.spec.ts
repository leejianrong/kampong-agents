import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// KAM-190: nodes show what the run did to them, live, in replay and live mode, with an icon and a word. A failed
// node links to its message in Test Run, and the next run clears the marks. The spec and the saved layout are
// never touched.
//
// Two servers on the market-etl template. The keyed one (4362) holds placeholder credentials, because a replay
// still resolves a tool's ${ENV} fields before it looks up its fixture; the keyless one (4363) makes a live run
// fail every symbol without touching the network.

const KEYED_PORT = 4362;
const KEYLESS_PORT = 4363;
const TEMPLATE = join("packages", "cli", "templates", "market-etl");
const KEYS = {
  ALPHAVANTAGE_API_KEY: "e2e-alpha-vantage-key",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_KEY: "e2e-supabase-key",
  SLACK_BOT_TOKEN: "xoxb-e2e-slack-token",
};

interface Started {
  child: ChildProcess;
  dir: string;
  spec: string;
}
const servers: Started[] = [];

async function start(port: number, env: Record<string, string>): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), "kampong-runstatus-"));
  cpSync(join(TEMPLATE, "agent.yaml"), join(dir, "agent.yaml"));
  cpSync(join(TEMPLATE, "fixtures"), join(dir, "fixtures"), { recursive: true });
  const spec = readFileSync(join(dir, "agent.yaml"), "utf8");
  const child = spawn(
    process.execPath,
    [join("packages", "cli", "dist", "cli.js"), "dev", dir, "--port", String(port)],
    { stdio: "ignore", env: { PATH: process.env["PATH"] ?? "", HOME: dir, ...env } },
  );
  const started = { child, dir, spec };
  servers.push(started);
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) return started;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("kampong dev did not start");
}

let keyed: Started;
let keyless: Started;
test.beforeAll(async () => {
  keyed = await start(KEYED_PORT, KEYS);
  keyless = await start(KEYLESS_PORT, {});
});

test.afterAll(() => {
  for (const s of servers) {
    s.child.kill();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

const badge = (page: Page, node: RegExp) =>
  page.getByLabel(node).first().getByTestId("node-run-status");

async function openCanvas(page: Page, port: number) {
  await page.goto(`http://127.0.0.1:${port}`);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await openPanel(page, "Test Run");
}

for (const size of [
  { width: 900, height: 700 },
  { width: 1440, height: 900 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test("a replay marks the steps that ran, inside the foreach too, and changes no file", async ({
      page,
    }) => {
      await openCanvas(page, KEYED_PORT);
      const layoutPath = join(keyed.dir, ".kampong", "layout.json");
      // The server writes the first layout as the canvas opens; wait for it, then a run must leave it alone.
      await expect.poll(() => existsSync(layoutPath)).toBe(true);
      const layoutBefore = readFileSync(layoutPath, "utf8");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.getByTestId("run-status")).toContainText("completed", { timeout: 20000 });
      const passed = page.locator('[data-testid="node-run-status"][data-status="passed"]');
      await expect(passed.first()).toBeVisible();
      // A word and an icon, not just a colour.
      await expect(passed.first()).toContainText("Passed");
      await expect(passed.first().locator('[aria-hidden="true"]')).toHaveText("✓");
      await expect(badge(page, /Tool step fetch/)).toContainText("Passed");
      // The template records no write for MSFT, so that one item fails in a replay and the loop carries on:
      // the nested step is marked failed although the run completed, and nothing else is.
      await expect(page.locator('[data-status="failed"]')).toHaveCount(1);
      await expect(badge(page, /Tool step write/)).toContainText("Failed");

      expect(readFileSync(join(keyed.dir, "agent.yaml"), "utf8")).toBe(keyed.spec);
      expect(readFileSync(layoutPath, "utf8")).toBe(layoutBefore);
    });

    test("a failed step links to its message, and the next run clears the marks", async ({
      page,
    }) => {
      await openCanvas(page, KEYLESS_PORT);
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

      const failed = badge(page, /Tool step fetch/);
      await expect(failed).toContainText("Failed");
      await expect(failed.locator('[aria-hidden="true"]')).toHaveText("✕");

      // Another panel on show: the link brings Test Run back and lands on the message.
      await openPanel(page, "Checks");
      await page
        .getByLabel(/Tool step fetch/)
        .first()
        .getByTestId("node-run-message")
        .click();
      await expect(page.getByRole("region", { name: "Test Run" })).toBeVisible();
      const row = page.locator('[data-testid="run-error-row"][data-run-step="fetch"]').first();
      await expect(row).toBeFocused();
      await expect(row).toContainText("ALPHAVANTAGE_API_KEY");

      // The next run clears the marks as it starts; a second live run fails them again from a clean slate.
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await page
        .getByRole("alertdialog", { name: "Run live?" })
        .getByRole("button", { name: "Run live" })
        .click();
      await expect(page.getByTestId("run-status")).toContainText("completed with 3 errors", {
        timeout: 20000,
      });
      await expect(badge(page, /Tool step fetch/)).toContainText("Failed");
      expect(readFileSync(join(keyless.dir, "agent.yaml"), "utf8")).toBe(keyless.spec);
    });
  });
}
