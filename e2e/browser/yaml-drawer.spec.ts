import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// KAM-202: the YAML viewer is a "For developers" drawer, closed by default. Checked in a real browser against
// `kampong dev` at 1440x900 and 900x700.

const PORT = 4347;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;

const SPEC = `version: "1.0"
agent:
  id: drawer_agent
  name: Drawer agent
  role: Support
  goal: Handle refunds.
  workflow:
    - step: parse
      action: extract the order
`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-drawer-"));
  writeFileSync(join(dir, "agent.yaml"), SPEC);
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

const noHorizontalScroll = () =>
  document.documentElement.scrollWidth <= document.documentElement.clientWidth;

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test("canvas has the full width and the page does not scroll sideways, drawer closed", async ({
      page,
    }) => {
      await page.goto(URL);
      await expect(page.getByText(/Trigger: Drawer agent/)).toBeVisible();
      await expect(page.getByTestId("yaml-preview")).toHaveCount(0);
      const surface = await page.locator(".md3-app__canvas-surface").boundingBox();
      expect(surface!.width).toBeGreaterThanOrEqual(size.width - 1);
      expect(await page.evaluate(noHorizontalScroll)).toBe(true);
      // Every run bar and status bar button is inside the viewport.
      for (const button of await page.locator(".md3-runbar button, .md3-statusbar button").all()) {
        const box = (await button.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      }
    });

    test("a form is fully usable with the drawer closed", async ({ page }) => {
      await page.goto(URL);
      await openPanel(page, "Add Tool");
      const form = page.getByRole("form", { name: "Add Tool" });
      await expect(form.getByLabel("Name")).toBeInViewport();
      await expect(form.getByRole("button", { name: "Save tool" })).toBeInViewport();
      expect(await page.evaluate(noHorizontalScroll)).toBe(true);
      const panel = await page.locator(".md3-app__side-pane").boundingBox();
      expect(panel!.width).toBeGreaterThanOrEqual(352);
    });

    test("opens and closes by button and by Alt+Y, and remembers it", async ({ page }) => {
      await page.goto(URL);
      const toggle = page.getByRole("button", { name: "For developers: show YAML" });
      await toggle.click();
      await expect(page.getByTestId("yaml-preview")).toContainText("drawer_agent");
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(await page.evaluate(noHorizontalScroll)).toBe(true);

      await page.reload();
      await expect(page.getByTestId("yaml-preview")).toContainText("drawer_agent");

      await page.keyboard.press("Alt+y");
      await expect(page.getByTestId("yaml-preview")).toHaveCount(0);
      await page.reload();
      await expect(page.getByText(/Trigger: Drawer agent/)).toBeVisible();
      await expect(page.getByTestId("yaml-preview")).toHaveCount(0);

      await page.keyboard.press("Alt+y");
      await expect(page.getByTestId("yaml-preview")).toBeVisible();
      await toggle.click();
      await expect(page.getByTestId("yaml-preview")).toHaveCount(0);
    });

    test("axe finds no scrollable-region-focusable violation with the drawer open", async ({
      page,
    }) => {
      await page.goto(URL);
      await page.getByTestId("yaml-drawer-toggle").click();
      await expect(page.getByTestId("yaml-preview")).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withRules(["scrollable-region-focusable"])
        .analyze();
      expect(results.violations).toEqual([]);
      await expect(page.getByTestId("yaml-preview")).toHaveAttribute("tabindex", "0");
    });
  });
}
