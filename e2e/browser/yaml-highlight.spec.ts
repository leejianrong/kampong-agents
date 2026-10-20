import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// KAM-210: selecting a node marks and scrolls to its lines in the "For developers" drawer, and a click on a
// line selects the node. Checked in a real browser against `kampong dev` at 1440x900 and 900x700.

const PORT = 4351;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;

// Long enough that the last steps start below the fold of the drawer.
const filler = Array.from(
  { length: 24 },
  (_, i) => `    - step: filler_${i}\n      action: filler work ${i}\n`,
).join("");
const SPEC = `version: "1.1"
agent:
  id: hl_agent
  name: Highlight agent
  role: Support
  goal: Handle refunds.
  workflow:
${filler}    - step: each
      foreach:
        items: "[1, 2]"
        as: x
        steps:
          - step: inner
            action: inner work
    - step: route
      branch:
        if: "true"
        then:
          - step: yes_arm
            action: say yes
        else:
          - step: no_arm
            action: say no
`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-hl-"));
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

const node = (page: import("@playwright/test").Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"]`);
const marked = (page: import("@playwright/test").Page) =>
  page.locator('[data-testid="yaml-preview"] [aria-current="true"]');

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test("a node marks and scrolls to its lines, in a foreach body and a branch arm", async ({
      page,
    }) => {
      await page.goto(URL);
      await expect(node(page, "workflow:inner")).toBeVisible();
      await page.getByTestId("yaml-drawer-toggle").click();
      await expect(page.getByTestId("yaml-preview")).toBeVisible();
      await expect(marked(page)).toHaveCount(0);

      await node(page, "workflow:inner").click();
      await expect(marked(page)).toHaveText(
        ["- step: inner", "action: inner work"].map((t) => new RegExp(t)),
      );
      await expect(marked(page).first()).toBeInViewport();

      await node(page, "workflow:no_arm").click();
      await expect(marked(page)).toHaveCount(2);
      await expect(marked(page).first()).toContainText("step: no_arm");
      await expect(marked(page).first()).toBeInViewport();

      await node(page, "workflow:filler_0").click();
      await expect(marked(page).first()).toContainText("step: filler_0");
      await expect(marked(page).first()).toBeInViewport();
      // The marking is more than colour: a leading bar.
      const bar = await marked(page)
        .first()
        .evaluate((el) => getComputedStyle(el).borderLeftWidth);
      expect(bar).toBe("3px");
    });

    test("a click on a line selects its node and opens the inspector", async ({ page }) => {
      await page.goto(URL);
      await expect(node(page, "workflow:inner")).toBeVisible();
      await page.getByTestId("yaml-drawer-toggle").click();
      await page.getByTestId("yaml-preview").getByText("say yes").click();
      await expect(node(page, "workflow:yes_arm")).toHaveClass(/selected/);
      await expect(marked(page).first()).toContainText("step: yes_arm");
      await expect(page.getByRole("form").first()).toBeVisible();
      expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(SPEC);
    });

    test("selection with the drawer closed shows when it is opened, and axe passes", async ({
      page,
    }) => {
      await page.goto(URL);
      await expect(node(page, "workflow:inner")).toBeVisible();
      await page.getByTestId("yaml-drawer-toggle").click();
      await page.getByTestId("yaml-drawer-toggle").click();
      await node(page, "workflow:route").click();
      await expect(page.getByTestId("yaml-preview")).toHaveCount(0);
      await page.getByTestId("yaml-drawer-toggle").click();
      await expect(marked(page).first()).toContainText("step: route");
      await expect(marked(page).first()).toBeInViewport();
      const results = await new AxeBuilder({ page })
        .include('[data-testid="yaml-preview"]')
        .withRules(["scrollable-region-focusable", "color-contrast", "aria-allowed-attr"])
        .analyze();
      expect(results.violations).toEqual([]);
      await expect(page.getByTestId("yaml-preview")).toHaveAttribute("tabindex", "0");
    });
  });
}
