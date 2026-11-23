import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// KAM-220: the first-run marks. A new workflow gets three one-line marks (template, Run, click a step), each
// leaves when the person does what it says, the tour can be skipped for good, and "Show tour" in the menu plays
// it again. Stored in this browser only. Real `kampong dev` on an empty folder, at 1440x900 and 900x700.

const PORT = 4367;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "market-etl");
let server: ChildProcess;
let dir: string;
let specPath: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-coach-"));
  specPath = join(dir, "agent.yaml");
  // No credentials at all: the Replay a template ships with has to work without them.
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

test.beforeEach(() => {
  if (existsSync(specPath)) unlinkSync(specPath);
  rmSync(join(dir, ".kampong", "fixtures"), { recursive: true, force: true });
});

const mark = (page: Page) => page.getByTestId("coach-mark");

async function expectInView(page: Page, size: { width: number; height: number }) {
  const box = (await mark(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test("walks a new workspace from a template, to Run, to a step, then stays gone", async ({
      page,
    }) => {
      await page.goto(URL);
      await expect(mark(page)).toHaveAttribute("data-mark", "template");
      await expect(mark(page)).toContainText("Pick a template");
      await expect(page.getByRole("region", { name: "Tour, step 1 of 3" })).toBeVisible();
      await expectInView(page, size);
      // Readable, and no accessibility violation inside the card, on every mark.
      const clean = async () => {
        const results = await new AxeBuilder({ page })
          .include('[data-testid="coach-mark"]')
          .analyze();
        expect(results.violations.map((v) => v.id)).toEqual([]);
      };
      await clean();

      await page.getByTestId("template-market-etl-use").click();
      await expect(mark(page)).toHaveAttribute("data-mark", "run");
      await expect(page.getByRole("region", { name: "Tour, step 2 of 3" })).toBeVisible();
      await expect(mark(page)).toContainText("no keys are needed");
      await expectInView(page, size);
      await clean();
      // It sits beside the Run button, not over it or over the palette (KAM-305). The bar settles as the options
      // arrive, so the card is read once it has.
      const run = (await page.getByTestId("run-button").boundingBox())!;
      await expect
        .poll(async () => (await mark(page).boundingBox())!.x)
        .toBeGreaterThanOrEqual(run.x + run.width);
      const palette = await page.locator(".md3-palette").first().boundingBox();
      if (palette) {
        expect((await mark(page).boundingBox())!.x).toBeGreaterThanOrEqual(
          palette.x + palette.width,
        );
      }

      await page.getByTestId("run-button").click();
      await expect(page.getByTestId("runbar-status")).toContainText(/completed|Finished/, {
        timeout: 20000,
      });
      await expect(mark(page)).toHaveAttribute("data-mark", "step");
      await expectInView(page, size);
      await clean();
      // And it covers no card: it points at the canvas, it does not hide it (KAM-305).
      const stepCard = (await mark(page).boundingBox())!;
      for (const node of await page.locator(".react-flow__node").all()) {
        const n = await node.boundingBox();
        if (!n) continue;
        const overlaps =
          stepCard.x < n.x + n.width &&
          n.x < stepCard.x + stepCard.width &&
          stepCard.y < n.y + n.height &&
          n.y < stepCard.y + stepCard.height;
        expect(overlaps, `the step mark over ${await node.getAttribute("data-id")}`).toBe(false);
      }

      await page
        .locator('.react-flow__node[data-id="workflow:report"]')
        .click({ position: { x: 8, y: 8 } });
      await expect(mark(page)).toHaveCount(0);

      // A reload does not bring it back.
      await page.reload();
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      await expect(mark(page)).toHaveCount(0);
    });

    test("Skip tour turns it off for good, with the keyboard too; Show tour plays it again", async ({
      page,
    }) => {
      await page.goto(URL);
      await expect(mark(page)).toBeVisible();
      await mark(page).getByRole("button", { name: "Skip tour" }).focus();
      await page.keyboard.press("Escape");
      await expect(mark(page)).toHaveCount(0);
      await page.reload();
      await expect(page.getByTestId("empty-state")).toBeVisible();
      await expect(mark(page)).toHaveCount(0);

      await page.getByRole("button", { name: "Menu", exact: true }).click();
      await page.getByRole("menuitem", { name: "Show tour" }).click();
      await expect(mark(page)).toHaveAttribute("data-mark", "template");
    });

    test("a workflow that was already there gets no tour, and Show tour starts at Run", async ({
      page,
    }) => {
      cpSync(join(TEMPLATE, "agent.yaml"), specPath);
      cpSync(join(TEMPLATE, "fixtures"), join(dir, "fixtures"), { recursive: true });
      await page.goto(URL);
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      await expect(mark(page)).toHaveCount(0);

      await page.getByRole("button", { name: "Menu", exact: true }).click();
      await page.getByRole("menuitem", { name: "Show tour" }).click();
      await expect(mark(page)).toHaveAttribute("data-mark", "run");
      // Two marks left, so it counts from 1 (KAM-305).
      await expect(page.getByRole("region", { name: "Tour, step 1 of 2" })).toBeVisible();
      await page.getByTestId("run-button").click();
      await expect(page.getByTestId("runbar-status")).toContainText(/completed|Finished/, {
        timeout: 20000,
      });
      await expect(mark(page)).toHaveAttribute("data-mark", "step");
      await mark(page).getByRole("button", { name: "Got it" }).click();
      await expect(mark(page)).toHaveCount(0);
      rmSync(join(dir, "fixtures"), { recursive: true, force: true });
    });
  });
}

// KAM-305: at a phone's width the log is a sheet over the canvas, so the step mark points at a row in its list and
// sits at the bottom, clear of the list and the error it explains.
test.describe("390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the step mark says to tap a step in the list and covers neither the list nor the error", async ({
    page,
  }) => {
    await page.goto(URL);
    await page.getByTestId("template-market-etl-use").click();
    await page.getByTestId("run-button").click();
    await expect(page.getByTestId("run-log-outcome")).toContainText("Finished", { timeout: 20000 });
    await expect(mark(page)).toHaveAttribute("data-mark", "step");
    await expect(mark(page)).toContainText("Tap a step in the list");
    await expectInView(page, { width: 390, height: 844 });
    const card = (await mark(page).boundingBox())!;
    for (const selector of [".md3-runlog__rows", ".md3-runlog__error"]) {
      const area = (await page.locator(selector).boundingBox())!;
      // Clear of the list and of the error message with its technical-detail link: the card sits in the sheet's empty
      // lower part.
      expect(card.y, selector).toBeGreaterThanOrEqual(area.y + area.height - 1);
    }
  });
});
