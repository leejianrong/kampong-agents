import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// KAM-216: the empty state and the menu list the templates; choosing one saves it with its recorded data and
// opens it. Real browser, real `kampong dev` on an empty folder, at 1440x900 and 900x700.

const PORT = 4357;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let specPath: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-gallery-"));
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

test.beforeEach(() => {
  if (existsSync(specPath)) unlinkSync(specPath);
  rmSync(join(dir, ".kampong", "fixtures"), { recursive: true, force: true });
});

const noHorizontalScroll = () =>
  document.documentElement.scrollWidth <= document.documentElement.clientWidth;

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test("the empty state lists the templates as business jobs, with chips and the offline badge", async ({
      page,
    }) => {
      await page.goto(URL);
      const gallery = page.getByTestId("empty-state-templates");
      await expect(gallery).toBeVisible();
      const etl = page.getByTestId("template-market-etl");
      await expect(etl).toContainText("Daily stock price tracker");
      await expect(etl).toContainText("Foreach");
      await expect(page.getByTestId("template-market-etl-offline")).toHaveText("Runs offline");
      await expect(page.getByTestId("template-support-triage")).toContainText(
        "Support inbox assistant",
      );
      // The primary action stays reachable without scrolling past the gallery.
      await expect(page.getByTestId("start-blank")).toBeInViewport();
      expect(await page.evaluate(noHorizontalScroll)).toBe(true);
    });

    test("choosing a template saves its spec and recorded data and opens it", async ({ page }) => {
      await page.goto(URL);
      await page.getByTestId("template-market-etl-use").scrollIntoViewIfNeeded();
      await page.getByTestId("template-market-etl-use").click();
      await expect(page.getByTestId("empty-state")).toHaveCount(0);
      await expect(page.getByTestId("spec-errors")).toHaveCount(0);
      expect(readFileSync(specPath, "utf8")).toContain("version: ");
      expect(readdirSync(join(dir, ".kampong", "fixtures")).length).toBeGreaterThan(0);
      // The pragma points at a file that exists from here, not at the repo's template folder.
      expect(readFileSync(specPath, "utf8")).not.toContain("../../../spec/schemas");
    });

    test("New from template in the menu asks before replacing a workflow", async ({ page }) => {
      await page.goto(URL);
      await page.getByTestId("template-support-triage-use").scrollIntoViewIfNeeded();
      await page.getByTestId("template-support-triage-use").click();
      await expect(page.getByTestId("empty-state")).toHaveCount(0);
      const first = readFileSync(specPath, "utf8");

      await page.getByRole("button", { name: "Menu" }).click();
      await page.getByRole("menuitem", { name: "New from template" }).click();
      await page.getByTestId("template-market-etl-use").click();
      // Nothing changes until the person confirms.
      expect(readFileSync(specPath, "utf8")).toBe(first);
      await page.getByTestId("template-market-etl-confirm").click();
      await expect.poll(() => readFileSync(specPath, "utf8")).not.toBe(first);
      expect(await page.evaluate(noHorizontalScroll)).toBe(true);
    });
  });
}
