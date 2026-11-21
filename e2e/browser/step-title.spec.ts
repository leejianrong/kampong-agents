import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// KAM-290: a step's plain-words title leads on its card and in the run log; the inspector edits it as one small
// change to the file, and the step's id is kept.

const PORT = 4388;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "market-etl");
let server: ChildProcess;
let dir: string;
let specPath: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-step-title-"));
  specPath = join(dir, "agent.yaml");
  cpSync(join(TEMPLATE, "agent.yaml"), specPath);
  cpSync(join(TEMPLATE, "fixtures"), join(dir, "fixtures"), { recursive: true });
  server = spawn(
    process.execPath,
    [join("packages", "cli", "dist", "cli.js"), "dev", dir, "--port", String(PORT)],
    { stdio: "ignore", env: { PATH: process.env["PATH"] ?? "", HOME: dir } },
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

// Each test edits the workflow, so each starts from the template as shipped.
test.beforeEach(() => {
  cpSync(join(TEMPLATE, "agent.yaml"), specPath);
});

test.afterAll(() => {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
});

const card = (page: import("@playwright/test").Page, id: string) =>
  page.locator(`.react-flow__node[data-id="workflow:${id}"]`);

for (const size of [
  { width: 900, height: 700 },
  { width: 1440, height: 900 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test("a card leads with the title, the inspector changes it, and the run log uses it", async ({
      page,
    }) => {
      await page.goto(URL);
      // The template ships titles: the card says it, and the id is in the accessible name and the tooltip.
      await expect(card(page, "report")).toContainText("Count what worked and what failed");
      await expect(card(page, "report")).toHaveAttribute(
        "aria-label",
        /Transform step report, Count what worked and what failed/,
      );

      // Change it from the inspector: one small edit of the file.
      await card(page, "report").click({ position: { x: 8, y: 8 } });
      const field = page.getByLabel(/Title \(optional\)/);
      await expect(field).toHaveValue("Count what worked and what failed");
      await field.fill("Tally the results");
      await field.press("Enter");
      await expect(card(page, "report")).toContainText("Tally the results");
      await expect
        .poll(() => readFileSync(specPath, "utf8"))
        .toMatch(/- step: report\n\s+title: "?Tally the results"?\n/);

      // Take it off: the card falls back to the id.
      await field.fill("");
      await field.press("Enter");
      await expect(card(page, "report")).toContainText("report");
      await expect.poll(() => readFileSync(specPath, "utf8")).not.toContain("Tally the results");

      // Put one back, run, and the run log names the step the same way.
      await field.fill("Tally the results");
      await field.press("Enter");
      await expect(card(page, "report")).toContainText("Tally the results");
      await page.getByTestId("run-button").click();
      await expect(page.getByTestId("run-log-outcome")).toBeVisible({ timeout: 20000 });
      await expect(
        page.locator('[data-testid="run-log-row"][data-run-step="report"]'),
      ).toContainText("Tally the results");
    });
  });
}
