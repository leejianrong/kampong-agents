import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// KAM-154: a branch's arms are nodes of their own, and Add Workflow Step can put a step in an arm, in a real
// browser against `kampong dev`. Checked at 1440x900 and 900x700, where the docked panel is short: the Save row
// of the longest form (the switch) stays in view.

const PORT = 4343;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let file: string;

const SPEC = `# Triage
version: "1.1"
agent:
  id: triage
  name: Triage
  role: Support
  goal: Route messages.
  tools:
    - name: reply
      action: http_request
      method: POST
      url: "https://x.example/reply"
  workflow:
    - step: route
      branch:
        switch: trigger.kind
        cases:
          bug:
            - step: answer
              type: tool
              tool: reply
        default:
          - step: other
            type: tool
            tool: reply
    - step: wrap
      type: transform
      set:
        done: "true"
`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-arms-"));
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
  test(`arms are nodes and a step can be added to one at ${size.width}x${size.height}`, async ({
    page,
  }) => {
    writeFileSync(file, SPEC);
    await page.setViewportSize(size);
    await page.goto(URL);
    // Each arm step is a node of its own, marked with its branch and arm.
    await expect(page.locator('[data-id="workflow:answer"]')).toContainText("in route · case bug");
    await expect(page.locator('[data-id="workflow:other"]')).toContainText("in route · default");

    await openPanel(page, "Add Workflow Step");
    await page.getByLabel("Add to").selectOption("route/default");
    await page.getByRole("button", { name: "Transform", exact: true }).click();
    await page.getByLabel("Step ID").fill("noted");
    await page.getByLabel("Values (one per line, name: expression)").fill("note: 'x'");
    const save = page.getByRole("button", { name: "Save step" });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport({ ratio: 1 });
    await save.click();

    await expect(page.locator('[data-id="workflow:noted"]')).toContainText("in route · default");
    const source = readFileSync(file, "utf8");
    expect(source).toContain("- step: noted");
    expect(source).toContain("# Triage");
  });

  test(`the switch form's Save is in view at ${size.width}x${size.height}`, async ({ page }) => {
    writeFileSync(file, SPEC);
    await page.setViewportSize(size);
    await page.goto(URL);
    await openPanel(page, "Add Workflow Step");
    await page.getByRole("button", { name: "Branch", exact: true }).click();
    await page.getByLabel("Branch on").selectOption("switch");
    const save = page.getByRole("button", { name: "Save step" });
    await expect(save).toBeInViewport({ ratio: 1 });
  });
}
