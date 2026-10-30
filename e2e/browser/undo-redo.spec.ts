import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// KAM-183 (ADR-0062): undo and redo in a real browser against `kampong dev`.
//  - an edit, then Ctrl+Z, puts the file back byte for byte (comments and formatting included); Ctrl+Shift+Z and
//    Ctrl+Y redo it; the Saved toast's Undo link and the menu do the same.
//  - an edit made outside the canvas clears the history with a notice, and never gets overwritten.
//  - Ctrl+Z inside a text field is the field's own undo and does not touch the workflow.
//  - dragging a card then Ctrl+Z puts the card back.
// Checked at 1440x900 and 900x700.

const PORT = 4383;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let file: string;

const SPEC = `# Undo me
version: "1.1"
agent:
  id: undoer
  name: Undoer   # the name
  role: Support
  goal: Handle refunds.
  trigger:
    type: schedule
    every: 1h
  workflow:
    - step: alpha
      action: do the first thing
    - step: bravo
      action: do the second thing
`;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-undo-"));
  file = join(dir, "agent.yaml");
  writeFileSync(file, SPEC);
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
  server.kill();
  rmSync(dir, { recursive: true, force: true });
});

const toast = (page: Page) => page.getByTestId("save-toast");
const node = (page: Page, step: string) =>
  page.locator(`.react-flow__node[data-id="workflow:${step}"]`);
const text = () => readFileSync(file, "utf8");

async function load(page: Page) {
  rmSync(join(dir, ".kampong"), { recursive: true, force: true });
  writeFileSync(file, SPEC);
  await page.goto(URL);
  await expect(node(page, "alpha")).toBeVisible();
}

async function saveTrigger(page: Page, every: string) {
  await openPanel(page, "Trigger");
  await page.getByRole("button", { name: "Use schedule" }).click();
  await page.getByLabel("Runs").selectOption("every");
  await page.getByLabel(/^Every/).fill(every);
  await page.getByRole("button", { name: "Save trigger" }).click();
  await expect(toast(page)).toContainText("Saved");
}

async function flowPosition(page: Page, step: string) {
  const transform = await node(page, step).evaluate((el) => (el as HTMLElement).style.transform);
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(transform);
  if (!m) throw new Error(`no translate in "${transform}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test("Ctrl+Z restores the file byte for byte, Ctrl+Shift+Z and Ctrl+Y redo it", async ({
      page,
    }) => {
      await load(page);
      await saveTrigger(page, "2h");
      const edited = text();
      expect(edited).toContain("every: 2h");
      expect(edited).not.toBe(SPEC);

      await page.keyboard.press("Control+z");
      await expect(toast(page)).toContainText("Undone");
      await expect.poll(text).toBe(SPEC); // the comments and the formatting are back as they were

      await page.keyboard.press("Control+Shift+z");
      await expect(toast(page)).toContainText("Redone");
      await expect.poll(text).toBe(edited);

      await expect(page.getByTestId("toast-action")).toHaveText("Undo");
      await page.keyboard.press("Control+z");
      await expect(page.getByTestId("toast-action")).toHaveText("Redo");
      await expect.poll(text).toBe(SPEC);
      await page.keyboard.press("Control+y");
      await expect(page.getByTestId("toast-action")).toHaveText("Undo");
      await expect.poll(text).toBe(edited);

      // Nothing left to undo past the first edit: said aloud, and the file is left alone.
      await page.keyboard.press("Control+z");
      await expect(page.getByTestId("toast-action")).toHaveText("Redo");
      await expect.poll(text).toBe(SPEC);
      await page.keyboard.press("Control+z");
      await expect(toast(page)).toHaveText("Nothing to undo.");
      expect(text()).toBe(SPEC);
    });

    test("the Undo link in the Saved toast, and the menu, restore the file", async ({ page }) => {
      await load(page);
      await saveTrigger(page, "3h");
      const axe = await new AxeBuilder({ page })
        .include('[data-testid="save-toast"]')
        .withRules(["color-contrast", "aria-allowed-attr"])
        .analyze();
      expect(axe.violations).toEqual([]);
      await page.getByTestId("toast-action").click();
      await expect.poll(text).toBe(SPEC);
      await expect(page.getByTestId("toast-action")).toHaveText("Redo");
      await page.getByTestId("toast-action").click();
      await expect.poll(text).toContain("every: 3h");

      // The menu: Undo is there and enabled; Redo is disabled (and says so) until something is undone.
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "Redo" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await page.getByRole("menuitem", { name: "Undo" }).click();
      await expect.poll(text).toBe(SPEC);
      await expect(page.getByTestId("toast-action")).toHaveText("Redo");

      // And the command palette.
      await page.keyboard.press("Control+k");
      await page.getByRole("combobox", { name: "Search commands" }).fill("redo");
      await page.keyboard.press("Enter");
      await expect.poll(text).toContain("every: 3h");
    });

    test("an edit made outside the canvas clears the history with a notice and is not overwritten", async ({
      page,
    }) => {
      await load(page);
      await saveTrigger(page, "2h");
      const external = `${text()}# edited in Cursor\n`;
      writeFileSync(file, external);
      await expect(toast(page)).toContainText("changed outside the canvas");
      await page.keyboard.press("Control+z");
      await expect(toast(page)).toHaveText("Nothing to undo.");
      expect(text()).toBe(external);
    });

    test("Ctrl+Z in a text field is the field's own undo and leaves the workflow alone", async ({
      page,
    }) => {
      await load(page);
      await saveTrigger(page, "2h");
      const edited = text();
      await openPanel(page, "Vars");
      await page.getByRole("button", { name: "Add var" }).click();
      const name = page.getByLabel("Name", { exact: false });
      await name.fill("symbols");
      await name.press("Control+z");
      await page.waitForTimeout(600);
      expect(text()).toBe(edited);
      await expect(toast(page)).not.toContainText("Undone");
    });

    test("Ctrl+Z puts a dragged card back where it was", async ({ page }) => {
      await load(page);
      // Wait for the opening fit to finish: a drag that starts while the view is still moving misses its target.
      let last = "";
      let steady = 0;
      for (let i = 0; i < 60 && steady < 4; i++) {
        const now = JSON.stringify(await node(page, "bravo").boundingBox());
        steady = now === last ? steady + 1 : 0;
        last = now;
        await page.waitForTimeout(100);
      }
      const before = await flowPosition(page, "bravo");
      const box = (await node(page, "bravo").boundingBox())!;
      await page.mouse.move(box.x + 30, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 30, box.y + box.height / 2 + 190, { steps: 12 });
      await page.mouse.up();
      await expect
        .poll(async () => (await flowPosition(page, "bravo")).y)
        .toBeGreaterThan(before.y + 100);
      expect(text()).toBe(SPEC);

      await page.keyboard.press("Control+z");
      await expect.poll(async () => flowPosition(page, "bravo")).toEqual(before);
      expect(text()).toBe(SPEC);
      await page.keyboard.press("Control+Shift+z");
      await expect
        .poll(async () => (await flowPosition(page, "bravo")).y)
        .toBeGreaterThan(before.y + 100);
    });
  });
}
