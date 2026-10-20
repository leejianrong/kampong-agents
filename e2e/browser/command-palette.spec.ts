import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// KAM-215: Ctrl/Cmd+K opens the command palette; filter, run a command, jump to a node, Esc, focus return and the
// discard prompt, in a real browser against `kampong dev` at 900x700 and 1440x900.

const PORT = 4353;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let file: string;

const SPEC = `version: "1.1"
agent:
  id: palette_agent
  name: Palette agent
  role: Support
  goal: Handle refunds.
  tools:
    - name: fetch_price
      action: http_request
      method: GET
      url: "https://x.example/prices"
  workflow:
    - step: parse
      action: extract the order
    - step: shape
      type: transform
      set:
        n: "1"
    - step: check
      type: validate
      assert: "true"
`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-cmdk-"));
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

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const search = (page: Page) => palette(page).getByRole("combobox", { name: "Search commands" });
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

for (const size of [
  { width: 900, height: 700 },
  { width: 1440, height: 900 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test.beforeEach(async ({ page }) => {
      writeFileSync(file, SPEC);
      await page.goto(URL);
      await expect(page.getByText(/Trigger: Palette agent/)).toBeVisible();
    });

    test("Ctrl+K opens it, the box has focus, Esc closes it and focus goes back", async ({
      page,
    }) => {
      const menu = page.getByRole("button", { name: "Menu", exact: true });
      await menu.focus();
      await page.keyboard.press("Control+k");
      await expect(palette(page)).toBeVisible();
      await expect(search(page)).toBeFocused();
      await expect(palette(page).getByRole("listbox")).toBeVisible();

      // Focus is trapped in the box.
      await page.keyboard.press("Tab");
      await expect(search(page)).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(search(page)).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(palette(page)).toHaveCount(0);
      await expect(menu).toBeFocused();

      // Ctrl+K again toggles it shut, and the menu entry opens it too.
      await page.keyboard.press("Control+k");
      await expect(palette(page)).toBeVisible();
      await page.keyboard.press("Control+k");
      await expect(palette(page)).toHaveCount(0);
      await menu.click();
      await page.getByRole("menuitem", { name: /Search commands/ }).click();
      await expect(palette(page)).toBeVisible();
    });

    test("typing filters; Enter runs the command", async ({ page }) => {
      await page.keyboard.press("Control+k");
      const all = await palette(page).getByRole("option").count();
      await search(page).fill("secret");
      await expect(palette(page).getByRole("option", { name: "Open Secrets" })).toBeVisible();
      expect(await palette(page).getByRole("option").count()).toBeLessThan(all);
      await search(page).fill("zzzz");
      await expect(palette(page).getByRole("status")).toContainText("No command matches");

      await search(page).fill("guardrails");
      await expect(search(page)).toHaveAttribute("aria-activedescendant", /.+/);
      await page.keyboard.press("Enter");
      await expect(palette(page)).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Set Guardrails" })).toBeVisible();
    });

    test("run, open code, add step and import are commands", async ({ page }) => {
      await page.keyboard.press("Control+k");
      await search(page).fill("test run");
      await palette(page).getByRole("option", { name: "Run (Test Run)" }).click();
      await expect(page.getByRole("region", { name: "Test Run" })).toBeVisible();

      await page.keyboard.press("Control+k");
      await search(page).fill("yaml drawer");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("yaml-preview")).toBeVisible();

      await page.keyboard.press("Control+k");
      await search(page).fill("add step");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("region", { name: "Add Workflow Step" })).toBeVisible();

      await page.keyboard.press("Control+k");
      await search(page).fill("import");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("region", { name: "Import from file" })).toBeVisible();
    });

    test("Go to a step selects it and opens its inspector, like a click", async ({ page }) => {
      await page.keyboard.press("Control+k");
      await search(page).fill("go to shape");
      await expect(palette(page).getByRole("option")).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(palette(page)).toHaveCount(0);
      await expect(page.getByTestId("node-inspector")).toBeVisible();
      await expect(node(page, "workflow:shape")).toHaveClass(/selected/);

      await page.keyboard.press("Control+k");
      await search(page).fill("fetch_price");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowUp");
      await palette(page).getByRole("option", { name: "Go to tool fetch_price" }).click();
      await expect(node(page, "tool:fetch_price")).toHaveClass(/selected/);
    });

    test("typed input in the inspector is not discarded without asking", async ({ page }) => {
      await node(page, "workflow:check").click();
      await page.getByLabel("Message when it fails (optional)").fill("half typed");
      await page.keyboard.press("Control+k");
      await search(page).fill("go to shape");
      await page.keyboard.press("Enter");
      const prompt = page.getByTestId("discard-prompt");
      await expect(prompt).toBeVisible();
      await expect(page.getByLabel("Message when it fails (optional)")).toHaveValue("half typed");
      await prompt.getByRole("button", { name: "Discard changes" }).click();
      await expect(node(page, "workflow:shape")).toHaveClass(/selected/);
    });

    test("axe finds nothing with the palette open", async ({ page }) => {
      await page.keyboard.press("Control+k");
      await expect(palette(page)).toBeVisible();
      const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
      expect(results.violations).toEqual([]);
      const wide = await new AxeBuilder({ page }).analyze();
      expect(wide.violations).toEqual([]);
    });
  });
}
