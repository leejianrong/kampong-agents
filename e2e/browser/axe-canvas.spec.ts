import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fitAll, openLoops } from "./harness/bars.js";

// KAM-200: axe finds no critical, serious or moderate issue on the canvas or on any panel open over it, the page has
// one main landmark and one h1, and Tab goes from the toolbar to the nodes in the order a run goes through them,
// without stopping on every line between them. The market-etl template has loops, a branch and a failed item, so the
// canvas has every kind of node on it.

const PORT = 4370;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "market-etl");
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-axe-"));
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

async function expectClean(page: Page, where: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  const blocking = results.violations
    .filter((v) => v.impact === "critical" || v.impact === "serious" || v.impact === "moderate")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(blocking, where).toEqual([]);
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
      await page.addStyleTag({ content: ".react-flow__minimap { display: none }" });
      await fitAll(page);
    });

    test("axe finds nothing serious or moderate on the canvas, the YAML drawer or any open panel", async ({
      page,
    }) => {
      await expectClean(page, "canvas");

      await page.getByTestId("yaml-drawer-toggle").click();
      await expectClean(page, "canvas with the YAML drawer");
      await page.getByTestId("yaml-drawer-toggle").click();

      await page.getByTestId("run-button").click();
      await expect(page.getByTestId("runbar-status")).toContainText("completed", {
        timeout: 20000,
      });
      await page.getByRole("button", { name: "Test Run", exact: true }).click();
      await expectClean(page, "Test Run with a finished run");

      for (const status of [/^Trigger$/, /^Vars$/, /^Guardrails$/, /^Checks$/, /^Secrets/]) {
        await page.getByRole("contentinfo").getByRole("button", { name: status }).click();
        await expect(page.getByRole("region", { name: /./ }).last()).toBeVisible();
        await expectClean(page, `the ${status} panel`);
      }

      await node(page, "workflow:report").click({ position: { x: 8, y: 8 } });
      await expectClean(page, "the step inspector");
      await node(page, "tool:fetch_daily").click({ position: { x: 8, y: 8 } });
      await expectClean(page, "the tool inspector");
      await node(page, "agent:market-etl").click({ position: { x: 8, y: 8 } });
      await expectClean(page, "the trigger inspector");
    });

    test("one main landmark and one h1, with no two landmarks sharing a name (axe)", async ({
      page,
    }) => {
      await expect(page.getByRole("main")).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await page
        .getByRole("contentinfo")
        .getByRole("button", { name: /^Trigger$/ })
        .click();
      // Two landmarks with one name are what axe's landmark-unique finds, with a panel open over the canvas.
      const results = await new AxeBuilder({ page })
        .withRules([
          "landmark-unique",
          "landmark-one-main",
          "landmark-no-duplicate-main",
          "region",
          "page-has-heading-one",
        ])
        .analyze();
      expect(results.violations.map((v) => v.id)).toEqual([]);
    });

    test("Tab reaches the toolbar first, then the nodes in run order, and does not stop on the lines", async ({
      page,
    }) => {
      await openLoops(page);
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      const stops: string[] = [];
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab");
        stops.push(
          await page.evaluate(() => {
            const a = document.activeElement;
            return a
              ? `${a.tagName.toLowerCase()}|${a.getAttribute("aria-label") ?? a.textContent?.trim().slice(0, 40) ?? ""}`
              : "none";
          }),
        );
      }
      // The top bar comes first.
      expect(stops[0]).toContain("show YAML");
      // No line is a stop.
      expect(stops.filter((s) => s.includes("Line from"))).toEqual([]);
      // The nodes come in run order: the trigger, then the loop, then the steps inside it as they run.
      const nodeStops = stops.filter((s) => /^div\|(Trigger,|.*step )/.test(s));
      const order = [
        "Trigger,",
        "Foreach step each_symbol",
        "Tool step fetch,",
        "Validate step check",
        "Transform step shape",
      ];
      const at = order.map((o) => nodeStops.findIndex((s) => s.includes(o)));
      expect(
        at.every((i) => i >= 0),
        nodeStops.join("\n"),
      ).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      // The tools, which the steps call, come after the steps rather than before them.
      const lastStep = nodeStops.map((s) => s.includes("step ")).lastIndexOf(true);
      const firstTool = nodeStops.findIndex((s) => s.includes("Tool fetch_daily"));
      if (firstTool >= 0) expect(firstTool).toBeGreaterThan(lastStep);
    });
  });
}
