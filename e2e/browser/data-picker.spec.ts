import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// KAM-218: "Insert data" beside an expression or prompt field lists what the field may read, with the values the
// last run gave. It works with no key (the template's fixtures answer a Replay), and it never saves anything itself:
// the spec file changes only when the step is saved.

const PORT = 4365;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "market-etl");
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-datapicker-"));
  cpSync(join(TEMPLATE, "agent.yaml"), join(dir, "agent.yaml"));
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

test.afterAll(() => {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
});

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

async function openStep(page: Page, id: string, title: string) {
  await node(page, id).click({ position: { x: 8, y: 8 } });
  const panel = page.getByRole("region", { name: title, exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

for (const size of [
  { width: 900, height: 700 },
  { width: 1440, height: 900 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test.beforeEach(async ({ page }) => {
      await page.goto(URL);
      await expect(node(page, "workflow:report")).toBeVisible();
      // Over 15 nodes, so the minimap shows; at this width it can cover the node clicked.
      await page.addStyleTag({ content: ".react-flow__minimap { display: none }" });
    });

    test("with no run it lists the names, runs a Replay for values, and inserts a reference", async ({
      page,
    }) => {
      const before = readFileSync(join(dir, "agent.yaml"), "utf8");
      const panel = await openStep(page, "workflow:report", "Step report");
      const field = panel.getByRole("combobox").first();
      await field.fill("");
      await panel.getByRole("button", { name: "Insert data" }).first().click();
      const picker = page.getByTestId("insert-data");
      await expect(page.getByTestId("insert-data-empty")).toBeVisible();
      await expect(picker.getByRole("button", { name: /^each_symbol/ }).first()).toBeVisible();

      await page.getByTestId("insert-data-replay").click();
      await expect(page.getByTestId("runbar-status")).toContainText("completed", {
        timeout: 20000,
      });

      await panel.getByRole("button", { name: "Insert data" }).first().click();
      await expect(page.getByTestId("insert-data-empty")).toHaveCount(0);
      // The value the run gave `each_symbol.results` shows beside it, and a click puts the reference in the field.
      const results = page
        .getByTestId("insert-data")
        .getByRole("button", { name: /^each_symbol\.results\b/ })
        .first();
      await expect(results).toContainText("list of");
      await results.click();
      await expect(page.getByTestId("insert-data")).toHaveCount(0);
      await expect(field).toHaveValue("each_symbol.results");
      await expect(field).toBeFocused();
      await expect(page.getByText(/Problem:/)).toHaveCount(0);

      // Nothing was saved by inserting.
      expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(before);
    });

    test("a prompt field inserts a reference inside braces", async ({ page }) => {
      const panel = await openStep(page, "workflow:summarize", "Step summarize");
      const prompt = panel.getByLabel("What should the model do?");
      await prompt.fill("Summarize ");
      await prompt.press("End");
      await panel.getByRole("button", { name: "Insert data" }).first().click();
      await page
        .getByTestId("insert-data")
        .getByRole("button", { name: /^delta\.change_pct\b/ })
        .first()
        .click();
      await expect(prompt).toHaveValue("Summarize {{ delta.change_pct }}");
    });
  });
}
