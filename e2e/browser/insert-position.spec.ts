import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// KAM-173: choose where a new step goes, in a real browser against `kampong dev`: "Add to" a loop and "Position"
// after a named step, a marker on the canvas while choosing, then the step is at that place in the file and its
// node is in view and flashed. Checked at 1440x900 and 900x700, where the docked panel is short.

const PORT = 4344;
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
          - step: check
            type: validate
            assert: "true"
          - step: shape
            type: transform
            set:
              label: symbol
    - step: report
      type: transform
      set:
        done: "true"
`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-position-"));
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

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test(`a step is added after a named step inside a loop at ${size.width}x${size.height}`, async ({
    page,
  }) => {
    writeFileSync(file, SPEC);
    await page.setViewportSize(size);
    await page.goto(URL);
    await openPanel(page, "Add Workflow Step");
    await page.getByLabel("Add to").selectOption("each_symbol/steps");
    // Positions are words and step names.
    await expect(page.getByLabel("Position").locator("option")).toHaveText([
      "At the end of each_symbol",
      "At the start of each_symbol",
      "After fetch",
      "After check",
      "After shape",
    ]);
    await page.getByLabel("Position").selectOption({ label: "After fetch" });
    await expect(page.locator(".md3-node--marker")).toContainText("New step goes here");

    await page.getByRole("button", { name: "Transform", exact: true }).click();
    await page.getByLabel("Step ID").fill("noted");
    await page.getByLabel("Values (one per line, name: expression)").fill("note: 'x'");
    const save = page.getByRole("button", { name: "Save step" });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport({ ratio: 1 });
    await save.click();

    // The step is in the file at the chosen place, and the rest of the file is as it was.
    await expect(page.locator('[data-id="workflow:noted"]')).toBeVisible();
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(/- step: fetch[\s\S]*?- step: noted[\s\S]*?- step: check/);
    expect(source).toContain("# Prices");
    // Panned into view and flashed.
    const node = page.locator('[data-id="workflow:noted"]');
    await expect(node).toHaveClass(/md3-node--flash/);
    await expect(node).toBeInViewport();
    await expect(page.locator(".md3-node--marker")).toHaveCount(0);
  });

  test(`an approval inside a loop is refused in plain words at ${size.width}x${size.height}`, async ({
    page,
  }) => {
    writeFileSync(file, SPEC);
    await page.setViewportSize(size);
    await page.goto(URL);
    await openPanel(page, "Add Workflow Step");
    await page.getByLabel("Add to").selectOption("each_symbol/steps");
    await page.getByLabel("Position").selectOption({ label: "At the start of each_symbol" });
    await page.getByRole("button", { name: "Approval", exact: true }).click();
    await page.getByLabel("Step ID").fill("ask");
    await page.getByRole("button", { name: "Save step" }).click();
    await expect(page.getByRole("alert")).toContainText(/approval/i);
    expect(readFileSync(file, "utf8")).toBe(SPEC);
  });
}
