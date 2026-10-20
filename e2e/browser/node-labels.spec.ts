import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// KAM-184 and KAM-187: the trigger node says what starts a run, a long step id stays inside its node (ellipsis,
// tooltip, full accessible name), and a 41-step workflow shows a minimap and can be panned and zoomed. Real
// browser against `kampong dev`, at 1440x900 and 900x700.

const PORT = 4354;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let file: string;

const LONG = "fetch_and_normalise_the_quarterly_price_history_for_every_symbol_x";

/** A 1.1 spec with `count` transform steps in a row; the first has a 60+ character id. */
function spec(count: number): string {
  const steps = Array.from({ length: count }, (_, i) => {
    const id = i === 0 ? LONG : `step_${String(i).padStart(2, "0")}`;
    return `    - step: ${id}\n      type: transform\n      set:\n        n${i}: "${i}"\n`;
  }).join("");
  return `# Labels fixture
version: "1.1"
agent:
  id: labels
  name: Labels
  role: Analyst
  goal: Check labels.
  workflow:
${steps}`;
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-labels-"));
  file = join(dir, "agent.yaml");
  writeFileSync(file, spec(41));
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
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const viewport = (page: Page) => page.locator(".react-flow__viewport").getAttribute("style");

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test.describe(`at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });
    test.beforeEach(async ({ page }) => {
      writeFileSync(file, spec(41));
      await page.goto(URL);
      await expect(node(page, "workflow:step_40")).toBeAttached();
    });

    test("the trigger node is labelled by type and follows a trigger save", async ({ page }) => {
      const trigger = node(page, "agent:labels");
      await expect(trigger).toHaveText("Manual");
      await expect(trigger).toHaveAttribute("aria-label", "Trigger, Manual");

      // Enter on the focused node opens it (at this zoom the node is a few pixels wide).
      await trigger.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Add schedule" }).click();
      await page.getByLabel("Runs").selectOption("every");
      await page.getByPlaceholder("6h").fill("6h");
      await page.getByRole("button", { name: "Save trigger" }).click();
      await expect(trigger).toHaveText("Schedule: every 6h");
      await expect(trigger).toHaveAttribute("aria-label", "Trigger, Schedule: every 6h");

      await page.getByRole("button", { name: "Use webhook" }).click();
      await page.getByLabel("Preset").selectOption("github");
      await page.getByLabel("Secret variable name").fill("GH_SECRET");
      await page.getByRole("button", { name: "Save trigger" }).click();
      await expect(trigger).toHaveText("Webhook (GitHub)");

      await page.getByRole("button", { name: "Remove trigger" }).click();
      await expect(trigger).toHaveText("Manual");
    });

    test("a long step id is cut inside its node, with a tooltip and the full accessible name", async ({
      page,
    }) => {
      const long = node(page, `workflow:${LONG}`);
      await expect(long).toHaveAttribute("aria-label", `Transform step ${LONG}`);
      const title = long.locator(".md3-node__title");
      await expect(title).toHaveAttribute("title", `Transform: ${LONG}`);
      // The text is cut, not spilled: its box is narrower than its text, and the node is no wider than its cap.
      const cut = await title.evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(cut).toBe(true);
      const box = await long.boundingBox();
      const scale = await page.evaluate(() => {
        const t = document.querySelector(".react-flow__viewport")!.getAttribute("style") ?? "";
        return Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? 1);
      });
      expect(box!.width / scale).toBeLessThanOrEqual(222);

      // Nothing inside any node reaches past its right edge.
      const overflowing = await page.evaluate(() =>
        [...document.querySelectorAll(".react-flow__node.md3-node")]
          .filter((n) => {
            const r = n.getBoundingClientRect();
            return [...n.querySelectorAll("*")].some(
              (c) => c.getBoundingClientRect().right > r.right + 1,
            );
          })
          .map((n) => n.getAttribute("data-id")),
      );
      expect(overflowing).toEqual([]);

      // Still reachable from the keyboard.
      await long.focus();
      await expect(long).toBeFocused();
    });

    test("a 41-step workflow has a minimap, and the canvas pans and zooms", async ({ page }) => {
      const minimap = page.locator(".react-flow__minimap");
      const overview = minimap.locator("svg");
      await expect(minimap).toBeVisible();
      await expect(overview.locator("title")).toHaveText(/Overview of the workflow/);
      expect(await page.locator(".react-flow__minimap-node").count()).toBeGreaterThanOrEqual(41);

      const before = await viewport(page);
      await page.getByRole("button", { name: "zoom in" }).click();
      await page.getByRole("button", { name: "zoom in" }).click();
      await expect.poll(() => viewport(page)).not.toBe(before);

      // Dragging in the minimap pans the view.
      const zoomed = await viewport(page);
      const box = (await minimap.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 10, { steps: 8 });
      await page.mouse.up();
      await expect.poll(() => viewport(page)).not.toBe(zoomed);

      const results = await new AxeBuilder({ page })
        .withRules([
          "aria-allowed-attr",
          "aria-valid-attr-value",
          "aria-required-children",
          "aria-required-parent",
          "button-name",
          "label",
          "nested-interactive",
          "scrollable-region-focusable",
          "svg-img-alt",
        ])
        .analyze();
      expect(results.violations.map((v) => v.id)).toEqual([]);
    });

    test("a long step id wraps inside its row in the steps list, not mid-word at the edge", async ({
      page,
    }) => {
      await openPanel(page, "Edit Steps");
      const row = page.getByTestId("steps-list").locator("li").first();
      await expect(row).toContainText(LONG);
      const out = await row.evaluate((li) => {
        const r = li.getBoundingClientRect();
        return [...li.querySelectorAll("*")].filter(
          (c) => c.getBoundingClientRect().right > r.right + 1,
        ).length;
      });
      expect(out).toBe(0);
      // It is one unbroken name, so it wraps only where it must (overflow-wrap), never with hyphens or clipping.
      const wrap = await row
        .locator(".md3-vars__name")
        .evaluate((el) => getComputedStyle(el).overflowWrap);
      expect(wrap).toBe("anywhere");
    });

    test("a small workflow has no minimap", async ({ page }) => {
      writeFileSync(file, spec(3));
      await expect(node(page, "workflow:step_40")).toHaveCount(0);
      await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
    });
  });
}
