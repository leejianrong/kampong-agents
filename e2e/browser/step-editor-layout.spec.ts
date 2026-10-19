import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// KAM-166/167 follow-up: the step editor's layout, checked in a real browser. jsdom has no layout, so a unit test
// cannot see a prompt cut off mid-sentence or a form that stops short of its panel; both shipped once.
// Runs `kampong dev` on a copy of the market-etl template (a version 1.1 spec), separate from the hosted harness.

const PORT = 4339;
const V10_PORT = 4340;
const UPGRADE_PORT = 4341;
const URL = `http://127.0.0.1:${PORT}`;
const V10_URL = `http://127.0.0.1:${V10_PORT}`;
const UPGRADE_URL = `http://127.0.0.1:${UPGRADE_PORT}`;
const servers: ChildProcess[] = [];
let dir: string;

async function start(folder: string, port: number) {
  servers.push(
    spawn(
      process.execPath,
      [join("packages", "cli", "dist", "cli.js"), "dev", folder, "--port", String(port)],
      { stdio: "ignore" },
    ),
  );
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`kampong dev did not start on ${port}`);
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-layout-"));
  cpSync(join("packages", "cli", "templates", "market-etl"), join(dir, "market-etl"), {
    recursive: true,
  });
  mkdirSync(join(dir, "starter"));
  cpSync(join("examples", "agent.yaml"), join(dir, "starter", "agent.yaml"));
  mkdirSync(join(dir, "upgrade"));
  cpSync(join("examples", "agent.yaml"), join(dir, "upgrade", "agent.yaml"));
  await Promise.all([
    start(join(dir, "market-etl"), PORT),
    start(join(dir, "upgrade"), UPGRADE_PORT),
    start(join(dir, "starter"), V10_PORT),
  ]);
});

test.afterAll(() => {
  for (const server of servers) server.kill();
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

// KAM-198: on a version 1.0 spec each panel says what needs 1.1 as one paragraph in its card. It used to be cut
// into flex columns that ran off the card.
for (const [button, what] of [
  ["Spec Vars", "Vars"],
  ["Trigger", "Schedule and poll triggers"],
  ["Edit Steps", "Per-step settings"],
] as const) {
  test(`${button}: the version 1.1 notice is one readable paragraph`, async ({ page }) => {
    await page.goto(V10_URL);
    await page.getByRole("button", { name: button, exact: true }).click();
    const notice = page.getByRole("status").filter({ hasText: "need spec version" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(what);
    const box = await notice.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const parent = el.parentElement!.getBoundingClientRect();
      return {
        // The sentence is one paragraph; the banner may also hold an Upgrade button beside it (KAM-199).
        paragraphs: el.querySelectorAll(":scope > p").length,
        // The sentence runs across the card; the broken version was cut into columns tens of pixels wide.
        textWidth: Math.round(el.querySelector(":scope > p")!.getBoundingClientRect().width),
        spills: el.scrollWidth > el.clientWidth || r.right > parent.right + 1,
      };
    });
    expect(box.paragraphs).toBe(1);
    expect(box.spills).toBe(false);
    expect(box.textWidth).toBeGreaterThan(250);
  });
}

// KAM-199: Upgrade to 1.1 from the notice. The preview shows the change, nothing is written until Upgrade, and
// afterwards the file is 1.1 and the step can be edited.
test("Upgrade to 1.1: preview, apply, and the step becomes editable", async ({ page }) => {
  const file = join(dir, "upgrade", "agent.yaml");
  await page.goto(UPGRADE_URL);
  await page.getByRole("button", { name: "Edit Steps", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit greet" })).toBeDisabled();

  await page.getByRole("button", { name: "Upgrade to 1.1…" }).click();
  const diff = page.getByLabel("Changes to the YAML");
  await expect(diff).toContainText('- version: "1.0"');
  await expect(diff).toContainText('+ version: "1.1"');
  expect(readFileSync(file, "utf8")).toContain('version: "1.0"'); // not written yet

  await page.getByRole("button", { name: "Upgrade", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "need spec version" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit greet" })).toBeEnabled();
  expect(readFileSync(file, "utf8")).toContain('version: "1.1"');
});

// KAM-177/178: every panel docks in the side pane (never over the canvas) and its Save is in view without scrolling,
// at the 1440x900 default and at 900x700, where the panel is short.
const FORMS: { open: string; then?: (page: Page) => Promise<void>; save: string }[] = [
  { open: "Add Tool", save: "Save tool" },
  { open: "Add Workflow Step", save: "Save step" },
  { open: "Set Guardrails", save: "Save guardrails" },
  {
    open: "Spec Vars",
    then: (page) => page.getByRole("button", { name: "Add var" }).click(),
    save: "Save var",
  },
  {
    open: "Trigger",
    then: (page) => page.getByRole("button", { name: /^Use webhook|^Add webhook/ }).click(),
    save: "Save trigger",
  },
  {
    open: "Edit Steps",
    then: (page) => page.getByRole("button", { name: "Edit shape" }).click(),
    save: "Save step",
  },
  {
    open: "Secrets",
    then: (page) => page.getByRole("button", { name: "Add secret" }).click(),
    save: "Save",
  },
  { open: "Checks", save: "Run checks" },
  { open: "Test Run", save: "Run" },
];

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  for (const form of FORMS) {
    test(`${form.open} at ${size.width}x${size.height}: docked, and ${form.save} is in view`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.goto(URL);
      await page.getByRole("button", { name: form.open, exact: true }).click();
      await form.then?.(page);
      const save = page.getByRole("button", { name: form.save, exact: true });
      await expect(save).toBeInViewport({ ratio: 1 });
      // The panel sits in the side pane, to the right of the canvas, so it covers no node.
      const geometry = await page.evaluate(() => {
        const panel = document.querySelector(".md3-panel")!.getBoundingClientRect();
        const canvas = document.querySelector(".md3-app__canvas-pane")!.getBoundingClientRect();
        return { panelLeft: panel.left, canvasRight: canvas.right };
      });
      expect(geometry.panelLeft).toBeGreaterThanOrEqual(geometry.canvasRight - 1);
    });
  }
}

// KAM-179: the toolbar's buttons are one height, stay inside the canvas column at any width the app supports (they
// used to run under the side pane, so Test Run covered the open panel's title), and a button that opened a panel
// shows as pressed. Panel content stays inside the pane too: the Trigger panel's three buttons wrap, not clip.
for (const width of [1440, 1100, 900]) {
  test(`toolbar at ${width}px: one height, inside the canvas column, no sideways scroll`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(URL);
    await page.getByRole("button", { name: "Trigger", exact: true }).click();
    const m = await page.evaluate(() => {
      const pane = document.querySelector(".md3-app__canvas-pane")!.getBoundingClientRect();
      const buttons = [...document.querySelectorAll(".md3-app__toolbar button")].map((b) =>
        b.getBoundingClientRect(),
      );
      const panel = document.querySelector(".md3-panel")!.getBoundingClientRect();
      const inside = [...document.querySelectorAll(".md3-panel__body button")].every(
        (b) => b.getBoundingClientRect().right <= panel.right + 1,
      );
      return {
        heights: [...new Set(buttons.map((r) => Math.round(r.height)))],
        overruns: buttons.filter((r) => r.right > pane.right + 1).length,
        hscroll: document.documentElement.scrollWidth > innerWidth,
        panelButtonsInside: inside,
      };
    });
    expect(m.heights).toHaveLength(1);
    expect(m.overruns).toBe(0);
    expect(m.hscroll).toBe(false);
    expect(m.panelButtonsInside).toBe(true);
    await expect(page.getByRole("button", { name: "Trigger", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "Secrets", exact: true })).toBeVisible();
  });
}
