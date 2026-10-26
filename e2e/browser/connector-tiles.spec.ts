import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// KAM-247: the connector tools of market-etl are tiled with their manifest's letters and colours, and a tool step
// wears its tool's tile. Real browser against `kampong dev`, at 1440x900 and 900x700.

const PORT = 4359;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-tiles-"));
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

test.use({ viewport: { width: 1440, height: 900 } });

test("a connector shows its letters on its own colour", async ({ page }) => {
  await page.goto(URL);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const tile = (id: string) =>
    page.locator(`.react-flow__node[data-id="${id}"] [data-testid="connector-tile"]`);
  await expect(tile("tool:fetch_daily")).toHaveText("AV");
  await expect(tile("tool:upsert_price")).toHaveText("Sb");
  await expect(tile("tool:post_alert")).toHaveText("S");
  const bg = await page
    .locator('.react-flow__node[data-id="tool:post_alert"] .kg-card__tile')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgb(74, 21, 75)");
});
