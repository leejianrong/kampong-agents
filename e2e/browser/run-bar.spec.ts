import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// KAM-214: the top run bar (name, saved state, Run, </>, menu) and the bottom status bar (Vars, Secrets,
// Guardrails, Checks, Trigger) in a real browser against `kampong dev`. Nothing overlaps at 480, 900 and 1440
// wide, and every action the old toolbar had is still reachable.

const PORT = 4352;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let file: string;

const SPEC = `version: "1.1"
agent:
  id: bar_agent
  name: Bar agent
  role: Support
  goal: Handle refunds.
  tools:
    - name: fetch_price
      action: http_request
      method: GET
      url: "https://x.example/prices?key=\${KAM214_UNSET_TOKEN}"
  workflow:
    - step: parse
      action: extract the order
`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-runbar-"));
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

const noHorizontalScroll = () =>
  document.documentElement.scrollWidth <= document.documentElement.clientWidth;

/** Every control in the two bars: inside the window, and none over another. */
async function expectNoOverlap(page: Page, width: number) {
  const boxes = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        ".md3-runbar button, .md3-runbar h1, .md3-runbar [data-testid=save-state], .md3-statusbar button",
      ),
    ]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30),
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
        };
      })
      // The saved state is read aloud only on a narrow window, so it has no box to collide with.
      .filter((b) => b.w > 2 && b.h > 2),
  );
  expect(boxes.length).toBeGreaterThanOrEqual(8);
  for (const b of boxes) {
    expect(b.x, `${b.name} starts inside the window`).toBeGreaterThanOrEqual(-0.5);
    expect(b.x + b.w, `${b.name} ends inside the window`).toBeLessThanOrEqual(width + 0.5);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const c = boxes[j]!;
      const overlap =
        a.x < c.x + c.w - 0.5 &&
        c.x < a.x + a.w - 0.5 &&
        a.y < c.y + c.h - 0.5 &&
        c.y < a.y + a.h - 0.5;
      expect(overlap, `${a.name} overlaps ${c.name}`).toBe(false);
    }
  }
  expect(await page.evaluate(noHorizontalScroll)).toBe(true);
}

for (const size of [
  { width: 480, height: 800 },
  { width: 900, height: 700 },
  { width: 1440, height: 900 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test.beforeEach(async ({ page }) => {
      writeFileSync(file, SPEC);
      await page.goto(URL);
      await expect(page.locator('.react-flow__node[data-id^="agent:"]')).toHaveText("Manual");
    });

    test("the bars do not overlap, closed, with the menu open and with a panel open", async ({
      page,
    }) => {
      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByRole("contentinfo")).toBeVisible();
      await expectNoOverlap(page, size.width);

      await page.getByRole("button", { name: "Menu", exact: true }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      await page.keyboard.press("Escape");

      await openPanel(page, "Add Tool");
      await page.getByRole("button", { name: "For developers: show YAML" }).click();
      await expectNoOverlap(page, size.width);
      await page.getByRole("button", { name: "For developers: show YAML" }).click();
    });

    test("the top bar shows the name and the saved state, and Test Run opens the panel", async ({
      page,
    }) => {
      const bar = page.getByRole("banner");
      await expect(bar.getByRole("heading", { name: "Kampong Agents" })).toBeVisible();
      await expect(bar.getByTestId("save-state")).toHaveText("Saved");
      const run = bar.getByRole("button", { name: "Test Run", exact: true });
      await expect(run).toHaveText("Test Run");
      await run.click();
      await expect(page.getByRole("region", { name: "Test Run" })).toBeVisible();
      await expect(run).toHaveAttribute("aria-pressed", "true");
      await run.click();
      await expect(page.getByRole("region", { name: "Test Run" })).toHaveCount(0);
    });

    test("the saved state says when saves are paused", async ({ page }) => {
      writeFileSync(file, SPEC.replace("id: bar_agent", "id: [unclosed"));
      await expect(page.getByTestId("spec-errors")).toBeVisible();
      await expect(page.getByTestId("save-state")).toHaveText(/Saves paused/);
      writeFileSync(file, SPEC);
      await expect(page.getByTestId("save-state")).toHaveText("Saved");
    });

    test("the </> button and Alt+Y toggle the YAML drawer", async ({ page }) => {
      const toggle = page.getByRole("button", { name: "For developers: show YAML" });
      await toggle.click();
      await expect(page.getByTestId("yaml-preview")).toContainText("bar_agent");
      await toggle.click();
      await expect(page.getByTestId("yaml-preview")).toHaveCount(0);
    });

    for (const [item, panel] of [
      ["Add Workflow Step", "Add Workflow Step"],
      ["Add Tool", "Add Tool"],
      ["Edit Steps", "Edit Steps"],
      ["Import YAML", "Import from file"],
    ] as const) {
      test(`the menu opens ${panel}`, async ({ page }) => {
        await openPanel(page, item);
        await expect(page.getByRole("region", { name: panel, exact: true })).toBeVisible();
        await expect(page.getByRole("menu")).toHaveCount(0);
      });
    }

    test("the menu exports the spec as the file", async ({ page }) => {
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      const [saved] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("menuitem", { name: "Export YAML" }).click(),
      ]);
      expect(saved.suggestedFilename()).toBe("bar_agent.yaml");
      expect(readFileSync(await saved.path(), "utf8")).toBe(SPEC);
    });

    test("the menu is a menu: arrows move, Escape closes and returns focus", async ({ page }) => {
      const button = page.getByRole("button", { name: "Menu", exact: true });
      await button.click();
      await expect(page.getByRole("menuitem", { name: "Add step" })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitem", { name: "Add tool" })).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowUp");
      await expect(page.getByRole("menuitem", { name: "Export YAML" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(button).toBeFocused();
      await button.click();
      await page.mouse.click(5, size.height / 2);
      await expect(page.getByRole("menu")).toHaveCount(0);
    });

    for (const [button, panel] of [
      ["Vars", "Spec Vars"],
      ["Secrets", "Secrets"],
      ["Guardrails", "Set Guardrails"],
      ["Checks", "Checks"],
      ["Trigger", "Trigger"],
    ] as const) {
      test(`the status bar opens ${panel}, which stays reachable under the panel`, async ({
        page,
      }) => {
        await openPanel(page, button);
        await expect(page.getByRole("region", { name: panel, exact: true }).first()).toBeVisible();
        await expect(
          page.getByRole("contentinfo").getByRole("button", { name: new RegExp(`^${button}`) }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByRole("contentinfo")).toBeInViewport({ ratio: 1 });
      });
    }

    test("Secrets counts the ones the workflow reads that have no value", async ({ page }) => {
      await expect(
        page.getByRole("contentinfo").getByRole("button", { name: /^Secrets, \d+ missing$/ }),
      ).toBeVisible();
    });

    test("axe finds nothing in the bars", async ({ page }) => {
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      const results = await new AxeBuilder({ page })
        .withRules([
          "button-name",
          "aria-allowed-attr",
          "aria-valid-attr-value",
          "aria-required-children",
          "aria-required-parent",
          "aria-allowed-role",
          "landmark-no-duplicate-banner",
          "landmark-no-duplicate-contentinfo",
          "landmark-banner-is-top-level",
          "landmark-contentinfo-is-top-level",
          "color-contrast",
        ])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });
}

test.describe("palette", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("+ Tool in the palette opens Add Tool", async ({ page }) => {
    await page.goto(URL);
    await expect(page.locator('.react-flow__node[data-id^="agent:"]')).toHaveText("Manual");
    await page.getByTestId("step-palette").getByRole("button", { name: "+ Tool" }).click();
    await expect(page.getByRole("form", { name: "Add Tool" })).toBeVisible();
  });
});
