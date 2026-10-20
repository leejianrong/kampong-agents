import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// KAM-181: a save is confirmed with a toast, the node flashes and the changed YAML lines are marked and scrolled
// to (only when the drawer is open). KAM-182: typed input in a panel survives a switch to another panel, and Esc
// closes a form (asking first when it has typed input). Real browser against `kampong dev`, at 1440x900 and 900x700.

const PORT = 4355;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let file: string;

// Long enough that the trigger, at the top, is off screen once the drawer is scrolled to the end.
const filler = Array.from(
  { length: 30 },
  (_, i) => `    - step: filler_${i}\n      action: filler work ${i}\n`,
).join("");
const SPEC = `version: "1.1"
agent:
  id: fb_agent
  name: Feedback agent
  role: Support
  goal: Handle refunds.
  trigger:
    type: schedule
    every: 1h
  workflow:
${filler}`;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-fb-"));
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

const changed = (page: Page) => page.locator('[data-testid="yaml-preview"] [data-changed="true"]');
const toast = (page: Page) => page.getByTestId("save-toast");

async function load(page: Page) {
  writeFileSync(file, SPEC);
  await page.goto(URL);
  await expect(page.locator('.react-flow__node[data-id="workflow:filler_0"]')).toBeVisible();
}

async function saveTrigger(page: Page, every: string) {
  await openPanel(page, "Trigger");
  await page.getByRole("button", { name: "Use schedule" }).click();
  await page.getByLabel("Runs").selectOption("every");
  await page.getByLabel(/^Every/).fill(every);
  await page.getByRole("button", { name: "Save trigger" }).click();
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test("saving the trigger confirms it, scrolls the open YAML to it, and clears", async ({
      page,
    }) => {
      await load(page);
      await page.getByTestId("yaml-drawer-toggle").click();
      const yaml = page.getByTestId("yaml-preview");
      await expect(yaml).toBeVisible();
      await yaml.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await expect(yaml.getByText("every: 1h")).not.toBeInViewport();

      await saveTrigger(page, "2h");

      // Announced politely, in words.
      await expect(toast(page)).toHaveAttribute("role", "status");
      await expect(toast(page)).toHaveAttribute("aria-live", "polite");
      await expect(toast(page)).toContainText("Saved: trigger");
      // The changed lines are marked and brought into view, and the node flashes.
      await expect(changed(page).first()).toContainText("trigger:");
      await expect(changed(page).first()).toBeInViewport();
      await expect(yaml.getByText("every: 2h")).toBeInViewport();
      await expect(page.locator('.react-flow__node[data-id="agent:fb_agent"]')).toBeVisible();
      const axe = await new AxeBuilder({ page })
        .include('[data-testid="save-toast"]')
        .withRules(["color-contrast", "aria-allowed-attr"])
        .analyze();
      expect(axe.violations).toEqual([]);

      // Both go away by themselves.
      await expect(changed(page)).toHaveCount(0, { timeout: 10_000 });
      await expect(toast(page)).toHaveText("", { timeout: 10_000 });
    });

    test("with reduced motion the marking is still there, as a still colour", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await load(page);
      await page.getByTestId("yaml-drawer-toggle").click();
      await saveTrigger(page, "3h");
      await expect(changed(page).first()).toContainText("trigger:");
      const animation = await changed(page)
        .first()
        .evaluate((el) => getComputedStyle(el).animationName);
      expect(animation).toBe("none");
      await expect(changed(page)).toHaveCount(0, { timeout: 10_000 });
    });

    test("a save never opens a closed drawer", async ({ page }) => {
      await load(page);
      const toggle = page.getByTestId("yaml-drawer-toggle");
      if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
      await saveTrigger(page, "4h");
      await expect(toast(page)).toContainText("Saved: trigger");
      await expect(page.getByTestId("yaml-preview")).toHaveCount(0);
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
    });

    test("a draft survives a panel switch; Esc closes a clean panel and asks about a dirty one", async ({
      page,
    }) => {
      await load(page);
      await openPanel(page, "Vars");
      await page.getByRole("button", { name: "Add var" }).click();
      await page.getByLabel("Name").fill("keepme");

      // Another panel, then back: the typed name is still there.
      await openPanel(page, "Trigger");
      await expect(page.getByRole("region", { name: "Spec Vars", exact: true })).toHaveCount(0);
      await openPanel(page, "Vars");
      await expect(page.getByLabel("Name")).toHaveValue("keepme");

      // Esc with typed input asks; Keep editing leaves it as it was.
      await page.getByLabel("Name").press("Escape");
      await expect(page.getByTestId("discard-prompt")).toBeVisible();
      await page.getByRole("button", { name: "Keep editing" }).click();
      await expect(page.getByLabel("Name")).toHaveValue("keepme");

      // Discard closes the panel and drops the draft.
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Discard changes" }).click();
      await expect(page.getByRole("region", { name: "Spec Vars", exact: true })).toHaveCount(0);
      await openPanel(page, "Vars");
      await expect(page.getByLabel("Name")).toHaveCount(0);

      // A clean panel closes on the first Esc.
      await page.keyboard.press("Escape");
      await expect(page.getByRole("region", { name: "Spec Vars", exact: true })).toHaveCount(0);
      await expect(page.getByTestId("discard-prompt")).toHaveCount(0);
    });
  });
}
