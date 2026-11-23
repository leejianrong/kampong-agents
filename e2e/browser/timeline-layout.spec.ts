import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

// KAM-302: switching the run log to Timeline keeps its height, the Add a step palette never folds onto itself on a
// short canvas, and the floating Steps/Assistant buttons stay off the first card.

const PORT = 4388;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "market-etl");
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-timeline-layout-"));
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

const box = async (l: Locator) => (await l.boundingBox())!;
const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width - 1 &&
  b.x < a.x + a.width - 1 &&
  a.y < b.y + b.height - 1 &&
  b.y < a.y + a.height - 1;

test.describe("1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Timeline keeps the log's height, and the palette's rows do not overlap", async ({
    page,
  }) => {
    await runOnce(page);
    const steps = (await box(page.locator(".md3-runlog__body"))).height;
    await page.getByTestId("run-log-view-timeline").click();
    await expect(page.getByTestId("run-timeline")).toBeVisible();
    expect((await box(page.locator(".md3-runlog__body"))).height).toBe(steps);

    const items = page.locator(".md3-palette:not(.md3-palette--collapsed) > *");
    const boxes = [];
    for (let i = 0; i < (await items.count()); i++) {
      const b = await items.nth(i).boundingBox();
      if (b) boxes.push(b);
    }
    expect(boxes.length).toBeGreaterThan(3);
    for (let i = 1; i < boxes.length; i++) {
      expect(overlap(boxes[i - 1]!, boxes[i]!), `palette child ${i - 1} and ${i}`).toBe(false);
    }
  });
});

test.describe("900x700", () => {
  test.use({ viewport: { width: 900, height: 700 } });

  test("after a run the floating Steps and Assistant buttons are off the first card", async ({
    page,
  }) => {
    await runOnce(page);
    await page.getByTestId("run-log-view-timeline").click();
    await expect(page.getByTestId("run-timeline")).toBeVisible();
    const first = await box(page.getByLabel(/^Trigger, /).first());
    for (const name of ["Steps", "Assistant"]) {
      const button = await box(page.locator(".md3-palette--collapsed").getByText(name).first());
      expect(overlap(button, first), `${name} over the first card`).toBe(false);
    }
  });
});
