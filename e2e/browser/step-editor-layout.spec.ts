import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// KAM-166/167 follow-up: the step editor's layout, checked in a real browser. jsdom has no layout, so a unit test
// cannot see a prompt cut off mid-sentence or a form that stops short of its panel; both shipped once.
// Runs `kampong dev` on a copy of the market-etl template (a version 1.1 spec), separate from the hosted harness.

const PORT = 4339;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-layout-"));
  cpSync(join("packages", "cli", "templates", "market-etl"), join(dir, "market-etl"), {
    recursive: true,
  });
  server = spawn(
    process.execPath,
    [
      join("packages", "cli", "dist", "cli.js"),
      "dev",
      join(dir, "market-etl"),
      "--port",
      String(PORT),
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 60; i++) {
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

async function open(page: import("@playwright/test").Page, step: string) {
  await page.goto(URL);
  await page.getByRole("button", { name: "Edit Steps", exact: true }).click();
  await page.getByRole("button", { name: `Edit ${step}` }).click();
  await expect(page.getByRole("form", { name: `Edit ${step}` })).toBeVisible();
}

/** Every textarea in the open form shows all of its text and fills the panel's width. */
async function expectFitsAndFills(page: import("@playwright/test").Page) {
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll("form textarea")].map((t) => ({
      name: t.getAttribute("aria-label") ?? t.closest("label")?.textContent ?? "",
      clipped: t.scrollHeight > t.clientHeight + 1,
      width: Math.round(t.getBoundingClientRect().width),
    })),
  );
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.clipped, `${box.name} cuts its text off`).toBe(false);
    expect(box.width, `${box.name} stops short of the panel`).toBeGreaterThan(360);
  }
}

test("a transform's expressions are shown whole and fill the panel", async ({ page }) => {
  await open(page, "shape");
  await expectFitsAndFills(page);
});

test("an action step's query and instructions are shown whole and fill the panel", async ({
  page,
}) => {
  await open(page, "summarize");
  await expectFitsAndFills(page);
});

test("Save step can be scrolled to and clicked", async ({ page }) => {
  await open(page, "shape");
  const save = page.getByRole("button", { name: "Save step" });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await save.click();
});
