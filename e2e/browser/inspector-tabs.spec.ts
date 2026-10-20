import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// KAM-212: every node form sits in one inspector shell with Setup, Output, Test and Settings tabs. The ARIA tabs
// pattern: role tablist / tab / tabpanel, roving tabindex, arrow keys, Home and End. Output and Test show only a
// placeholder until the run-status work has data. Real browser against `kampong dev`, at 1440x900 and 900x700.

const PORT = 4349;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let file: string;

const SPEC = `version: "1.1"
agent:
  id: tabs
  name: Tabs agent
  role: Support
  goal: Handle refunds.
  tools:
    - name: lookup
      action: http_request
      method: GET
      url: "https://api.example.com/orders"
  workflow:
    - step: parse
      action: extract the order
      temperature: 0.2
    - step: call
      type: tool
      tool: lookup
    - step: shape
      type: transform
      set:
        n: "1"
    - step: check
      type: validate
      assert: "true"
    - step: loop
      foreach:
        items: trigger.items
        as: item
        steps:
          - step: inner
            type: transform
            set:
              m: item.id
    - step: route
      branch:
        if: "true"
        then:
          - step: arm
            type: transform
            set:
              k: "2"
`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-tabs-"));
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

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const inspector = (page: Page) => page.getByTestId("node-inspector");
const tab = (page: Page, name: string) => inspector(page).getByRole("tab", { name, exact: true });

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });
    test.beforeEach(async ({ page }) => {
      writeFileSync(file, SPEC);
      await page.goto(URL);
      await expect(node(page, "workflow:parse")).toBeVisible();
    });

    test("model, tool, transform, validate, foreach and branch forms all have the four tabs", async ({
      page,
    }) => {
      for (const id of [
        "workflow:parse",
        "workflow:call",
        "workflow:shape",
        "workflow:check",
        "workflow:loop",
        "workflow:route",
        "tool:lookup",
      ]) {
        await node(page, id).click({ position: { x: 8, y: 8 } });
        await expect(inspector(page), id).toBeVisible();
        await expect(inspector(page).getByRole("tablist"), id).toHaveCount(1);
        await expect(inspector(page).getByRole("tab"), id).toHaveText([
          "Setup",
          "Output",
          "Test",
          "Settings",
        ]);
        await expect(tab(page, "Setup"), id).toHaveAttribute("aria-selected", "true");
        await expect(inspector(page).getByRole("tabpanel"), id).toHaveCount(1);
      }
    });

    test("clicking a tab shows its panel and hides the others", async ({ page }) => {
      await node(page, "workflow:parse").click();
      await expect(page.getByLabel("What should the model do?")).toBeVisible();
      await tab(page, "Settings").click();
      await expect(tab(page, "Settings")).toHaveAttribute("aria-selected", "true");
      await expect(tab(page, "Setup")).toHaveAttribute("aria-selected", "false");
      await expect(page.getByLabel("Creativity (temperature)")).toBeVisible();
      await expect(page.getByLabel("What should the model do?")).toBeHidden();
      await expect(inspector(page).getByRole("tabpanel")).toHaveAccessibleName("Settings");
    });

    test("arrow keys, Home and End move between tabs, and Tab goes on to the panel", async ({
      page,
    }) => {
      await node(page, "workflow:parse").click();
      await tab(page, "Setup").focus();
      await page.keyboard.press("ArrowRight");
      await expect(tab(page, "Output")).toBeFocused();
      await expect(tab(page, "Output")).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowRight");
      await expect(tab(page, "Test")).toBeFocused();
      await page.keyboard.press("End");
      await expect(tab(page, "Settings")).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(tab(page, "Setup")).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(tab(page, "Settings")).toBeFocused();
      await page.keyboard.press("Home");
      await expect(tab(page, "Setup")).toBeFocused();
      // Only the open tab is in the tab order; Tab leaves the list for the open panel.
      await expect(tab(page, "Output")).toHaveAttribute("tabindex", "-1");
      await page.keyboard.press("Tab");
      await expect(inspector(page).getByRole("tabpanel")).toBeFocused();
    });

    test("Output and Test say to run the workflow and show nothing else", async ({ page }) => {
      await node(page, "workflow:call").click();
      for (const name of ["Output", "Test"]) {
        await tab(page, name).click();
        const panel = inspector(page).getByRole("tabpanel");
        await expect(panel).toContainText("Run the workflow to see output");
        await expect(panel.locator("pre, code, table")).toHaveCount(0);
      }
    });

    test("a setting changed on the Settings tab is saved with the form", async ({ page }) => {
      await node(page, "workflow:loop").click();
      await expect(page.getByLabel("List to go through")).toBeVisible();
      await tab(page, "Settings").click();
      await page.getByLabel("How many at once").fill("3");
      await page.getByRole("button", { name: "Save step" }).click();
      await expect(inspector(page)).toHaveCount(0);
      await expect.poll(() => readFileSync(file, "utf8")).toContain("concurrency: 3");
    });

    test("axe finds nothing on any tab", async ({ page }) => {
      await node(page, "workflow:parse").click();
      for (const name of ["Setup", "Output", "Test", "Settings"]) {
        await tab(page, name).click();
        const results = await new AxeBuilder({ page })
          .withRules([
            "aria-allowed-attr",
            "aria-valid-attr-value",
            "aria-required-children",
            "aria-required-parent",
            "aria-allowed-role",
            "button-name",
            "label",
            "nested-interactive",
            "scrollable-region-focusable",
            "color-contrast",
          ])
          .analyze();
        expect(results.violations, name).toEqual([]);
      }
    });
  });
}
