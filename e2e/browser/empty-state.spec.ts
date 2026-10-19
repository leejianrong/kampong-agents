import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// KAM-196: `kampong dev` on a folder with no spec opens an empty state (no error banner), "Start blank" writes a
// valid spec with the schema pragma, a workflow with no steps shows its own empty state, and a broken YAML file
// says which line to fix and that saves are paused. Real browser, real `kampong dev`, at 1440x900 and 900x700.

const PORT = 4361;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let specPath: string;

const HEAD = `version: "1.0"
agent:
  id: empty_agent
  name: Empty agent
  role: Support
  goal: Handle refunds.
`;
const EMPTY_WORKFLOW = `${HEAD}  workflow: []\n`;
const ONE_STEP = `${HEAD}  workflow:\n    - step: parse\n      action: extract the order\n`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-empty-"));
  specPath = join(dir, "agent.yaml");
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

// Every test starts from "no spec file", the state of an empty folder.
test.beforeEach(() => {
  if (existsSync(specPath)) unlinkSync(specPath);
});

const noHorizontalScroll = () =>
  document.documentElement.scrollWidth <= document.documentElement.clientWidth;

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test("an empty folder shows the empty state with no error banner", async ({ page }) => {
      await page.goto(URL);
      await expect(page.getByRole("heading", { name: "Start a new workflow" })).toBeVisible();
      await expect(page.getByTestId("spec-error-banner")).toHaveCount(0);
      await expect(page.getByTestId("spec-errors")).toHaveCount(0);
      await expect(page.getByTestId("start-blank")).toBeInViewport();
      expect(await page.evaluate(noHorizontalScroll)).toBe(true);
      expect(existsSync(specPath)).toBe(false);
    });

    test("Start blank writes a valid spec with the schema pragma and opens it", async ({
      page,
    }) => {
      await page.goto(URL);
      await page.getByTestId("start-blank").click();
      await expect(page.getByTestId("empty-state")).toHaveCount(0);
      await expect(page.getByText(/Workflow: answer/)).toBeVisible();
      const onDisk = readFileSync(specPath, "utf8");
      expect(onDisk.split("\n")[0]).toMatch(
        /^# yaml-language-server: \$schema=\S*agent-spec\.v1\.0\.schema\.json$/,
      );
      expect(onDisk).toContain('version: "1.0"');
      await expect(page.getByTestId("spec-errors")).toHaveCount(0);
    });

    test("a workflow with no steps shows its own empty state, and Test Run says why", async ({
      page,
    }) => {
      writeFileSync(specPath, EMPTY_WORKFLOW);
      await page.goto(URL);
      await expect(
        page.getByRole("heading", { name: "This workflow has no steps yet" }),
      ).toBeVisible();
      await expect(page.getByTestId("spec-errors")).toHaveCount(0);

      await page.getByRole("button", { name: "Test Run" }).click();
      await expect(page.getByTestId("run-blocked")).toContainText("no steps yet");
      await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();

      await page.getByTestId("empty-add-step").click();
      const form = page.getByRole("form", { name: "Add Workflow Step" });
      await form.getByLabel("Step ID").fill("first");
      await form.getByLabel("Action").fill("check_knowledge");
      await form.getByRole("button", { name: "Save step" }).click();
      await expect(page.getByText(/Workflow: first/)).toBeVisible();
      await expect(page.getByTestId("empty-state")).toHaveCount(0);
    });

    test("broken YAML keeps the last valid version, names the line, and says saves are paused", async ({
      page,
    }) => {
      writeFileSync(specPath, ONE_STEP);
      await page.goto(URL);
      await expect(page.getByText(/Workflow: parse/)).toBeVisible();

      writeFileSync(specPath, `${ONE_STEP}  tools: [unclosed\n`);
      const summary = page.getByTestId("spec-errors-summary");
      await expect(summary).toContainText("Showing the last valid version");
      await expect(summary).toContainText(/fix line \d+/);
      await expect(summary).toContainText("Saves are paused");
      await expect(page.getByText(/Workflow: parse/)).toBeVisible();
      expect(await page.evaluate(noHorizontalScroll)).toBe(true);
    });
  });
}
