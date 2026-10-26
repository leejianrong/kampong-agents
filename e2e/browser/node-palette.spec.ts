import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fitAll, openPanel } from "./harness/bars.js";

// KAM-213: the step palette (left rail, search, `/`) and the "+" on a line, in a real browser against
// `kampong dev`. A step is inserted between two others, inside a foreach and into a branch arm, and the file
// changes by one inserted block. Checked at 1440x900 and 900x700, where the rail starts collapsed.

const PORT = 4351;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let file: string;

const SPEC = `# Prices
version: "1.1"
agent:
  id: prices
  name: Prices
  role: Analyst
  goal: Load prices.
  tools:
    - name: fetch_price
      action: http_request
      method: GET
      url: "https://x.example/{{ symbol }}"
  workflow:
    - step: each_symbol
      foreach:
        items: trigger.symbols
        as: symbol
        steps:
          - step: fetch
            type: tool
            tool: fetch_price
          - step: shape
            type: transform
            set:
              label: symbol
    - step: route
      branch:
        switch: trigger.kind
        cases:
          bug:
            - step: answer
              type: tool
              tool: fetch_price
        default:
          - step: other
            type: tool
            tool: fetch_price
    - step: report
      type: transform
      set:
        done: "true"
`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-palette-"));
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
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const edge = (page: Page, id: string) => page.locator(`.react-flow__edge[data-id="${id}"]`);

/** The lines of `after` minus those of `before`, which must all still be there in order: one inserted block. */
function insertedBlock(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let i = 0;
  const added: number[] = [];
  b.forEach((line, at) => {
    if (i < a.length && line === a[i]) i++;
    else added.push(at);
  });
  expect(i, "every old line is still there, in order").toBe(a.length);
  expect(added.length).toBeGreaterThan(0);
  // Contiguous: one block, not scattered edits.
  expect(added[added.length - 1]! - added[0]! + 1).toBe(added.length);
  return added.map((at) => b[at]!);
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test.describe(`at ${size.width}x${size.height}`, () => {
    test.beforeEach(async ({ page }) => {
      writeFileSync(file, SPEC);
      await page.setViewportSize(size);
      await page.goto(URL);
      await expect(page.locator('[data-id="workflow:report"]')).toBeVisible();
      await fitAll(page);
    });

    test("a step goes between two others from the + on the line", async ({ page }) => {
      // The "+" sits on the middle of the line: the pointer meets it there and it shows.
      const plus = page.getByRole("button", { name: "Insert a step before route" });
      await expect(plus).toHaveCSS("opacity", "0");
      await plus.hover();
      await expect(plus).toHaveCSS("opacity", "1");
      await plus.click();
      const picker = page.getByRole("dialog", { name: "Insert a step before route" });
      await expect(picker).toBeVisible();
      await picker.getByRole("option", { name: /Transform/ }).click();

      await expect(page.getByLabel("Add to")).toHaveValue("");
      await expect(page.getByLabel("Position")).toHaveValue("after:0");
      await expect(page.getByLabel("Step ID")).toBeFocused();
      await page.getByLabel("Step ID").fill("between");
      await page.getByLabel("Values (one per line, name: expression)").fill("note: 'x'");
      await page.getByRole("button", { name: "Save step" }).click();

      await expect(page.locator('[data-id="workflow:between"]')).toBeVisible();
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/- step: each_symbol[\s\S]*?- step: between[\s\S]*?- step: route/);
      const block = insertedBlock(SPEC, source);
      expect(block.join("\n")).toContain("step: between");
      expect(block.length).toBeLessThan(8);
    });

    test("a step goes inside a foreach, by keyboard, from the line", async ({ page }) => {
      const line = edge(page, "workflow:each_symbol->workflow:fetch");
      await line.focus();
      await page.keyboard.press("Enter");
      const picker = page.getByRole("dialog", { name: "Insert a step before fetch" });
      await expect(picker.getByRole("combobox", { name: "Search steps to insert" })).toBeFocused();
      await expect(picker.getByRole("listbox")).toBeVisible();
      await page.keyboard.type("check");
      await expect(picker.getByRole("option")).toHaveCount(1);
      await page.keyboard.press("Enter");

      await expect(page.getByLabel("Add to")).toHaveValue("each_symbol/steps");
      await expect(page.getByLabel("Position")).toHaveValue("start");
      await expect(page.getByRole("button", { name: "Validate", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.getByLabel("Step ID").fill("guard");
      await page.getByLabel(/^Assert/).fill("true");
      await page.getByRole("button", { name: "Save step" }).click();

      await expect(page.locator('[data-id="workflow:guard"]')).toBeVisible();
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/steps:\s+- step: guard[\s\S]*?- step: fetch/);
      insertedBlock(SPEC, source);
    });

    test("a step goes into a branch arm from the line into its first step", async ({ page }) => {
      const line = edge(page, "workflow:route->workflow:answer");
      await line.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.type("new values");
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Add to")).toHaveValue("route/cases/bug");
      await expect(page.getByLabel("Position")).toHaveValue("start");
      await page.getByLabel("Step ID").fill("note");
      await page.getByLabel("Values (one per line, name: expression)").fill("seen: 'yes'");
      await page.getByRole("button", { name: "Save step" }).click();

      await expect(page.locator('[data-id="workflow:note"]')).toBeVisible();
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/bug:\s+- step: note[\s\S]*?- step: answer/);
      insertedBlock(SPEC, source);
    });

    test("Escape closes the picker and the line keeps focus", async ({ page }) => {
      const line = edge(page, "workflow:shape->workflow:route");
      await line.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog").getByRole("listbox")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(line).toBeFocused();
    });

    test("the palette: / focuses the search and a row opens the form at the end", async ({
      page,
    }) => {
      await page.locator("body").press("/");
      const search = page.getByRole("combobox", { name: "Search steps", exact: true });
      await expect(search).toBeFocused();
      await page.keyboard.type("loop");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Foreach", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page.getByLabel("Position")).toHaveValue("end");
      // No sideways scroll, with the rail and the panel both open.
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(wide).toBe(false);
    });

    test("the palette is tiles in four groups, with a chip for where a step goes and the description as a tooltip", async ({
      page,
    }) => {
      // A narrow window keeps the rail shut until `/` opens it.
      await page.locator("body").press("/");
      const palette = page.getByTestId("step-palette");
      for (const name of ["Do work", "Work with data", "Control the flow", "Connectors"]) {
        await expect(palette.getByRole("group", { name })).toBeAttached();
      }
      await expect(palette.getByTestId("picker-where")).toHaveText("Goes at the end");
      const tile = palette.getByRole("option", { name: "Transform", exact: true });
      await expect(tile).toHaveAttribute("title", /without asking the model/);
      // A connector tile opens Add Tool on that connector: the first-party Slack component, once.
      await expect(palette.getByRole("option", { name: "Slack", exact: true })).toHaveCount(1);
      await palette.getByRole("option", { name: "Slack", exact: true }).click();
      await expect(page.getByLabel("Component")).toHaveValue(/^kampong\/slack@/);
    });

    test("a line's + names where the step goes and offers steps only", async ({ page }) => {
      await edge(page, "workflow:shape->workflow:route").focus();
      await page.keyboard.press("Enter");
      const picker = page.getByRole("dialog", { name: "Insert a step before route" });
      await expect(picker.getByTestId("picker-where")).toHaveText("Goes before route");
      await expect(picker.getByRole("group", { name: "Connectors" })).toHaveCount(0);
    });

    test("the toolbar button still opens the plain form", async ({ page }) => {
      await openPanel(page, "Add Workflow Step");
      await expect(page.getByRole("button", { name: "Action", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    test("axe finds nothing with the picker open", async ({ page }) => {
      await edge(page, "workflow:shape->workflow:route").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog").getByRole("listbox")).toBeVisible();
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
        ])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });
}
