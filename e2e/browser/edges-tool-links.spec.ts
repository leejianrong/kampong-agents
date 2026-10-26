import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { fitAll, openLoops } from "./harness/bars.js";

// KAM-185: in the market-etl layout no line passes behind a node, a tool and the steps that call it light each
// other up on hover and on keyboard focus, and a line is named by its steps' labels, not internal ids. Real browser
// against `kampong dev`, at 1440x900 and 900x700.

const PORT = 4356;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-edges-"));
  copyFileSync(
    join("packages", "cli", "templates", "market-etl", "agent.yaml"),
    join(dir, "agent.yaml"),
  );
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

/** Every line's sampled points, in screen pixels, against every card (not a loop's outline, which lines enter) but the line's own two ends. */
async function crossings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const boxes = [
      ...document.querySelectorAll<HTMLElement>(
        ".react-flow__node:not(.react-flow__node-loopGroup)",
      ),
    ].map((n) => ({
      id: n.dataset.id!,
      r: n.getBoundingClientRect(),
    }));
    const hits: string[] = [];
    for (const edge of document.querySelectorAll<SVGGElement>(".react-flow__edge")) {
      const id = edge.dataset.id!;
      const [source, target] = id.split("->");
      const path = edge.querySelector<SVGPathElement>("path.react-flow__edge-path")!;
      const m = path.getScreenCTM()!;
      const length = path.getTotalLength();
      for (let i = 0; i <= 60; i++) {
        const p = path.getPointAtLength((length * i) / 60);
        const x = m.a * p.x + m.c * p.y + m.e;
        const y = m.b * p.x + m.d * p.y + m.f;
        for (const { id: nodeId, r } of boxes) {
          if (nodeId === source || nodeId === target) continue;
          if (x > r.left && x < r.right && y > r.top && y < r.bottom)
            hits.push(`${id} behind ${nodeId}`);
        }
      }
    }
    return [...new Set(hits)];
  });
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test.describe(`at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });
    test.beforeEach(async ({ page }) => {
      await page.goto(URL);
      await expect(node(page, "workflow:report")).toBeAttached();
      await expect(page.locator(".react-flow__edge")).not.toHaveCount(0);
      await openLoops(page);
    });

    test("no line passes behind a node in the market-etl layout", async ({ page }) => {
      // The branch's fall-through to the step after its arms is the line that used to cut across them.
      await expect(
        page.locator('.react-flow__edge[data-id="workflow:anomaly->workflow:report"]'),
      ).toBeAttached();
      expect(await crossings(page)).toEqual([]);
    });

    test("the run flows left to right and the tools sit in a row under it, out of the way of every line", async ({
      page,
    }) => {
      await fitAll(page);
      const trigger = (await node(page, "agent:market-etl").boundingBox())!;
      const first = (await node(page, "workflow:each_symbol").boundingBox())!;
      expect(first.x).toBeGreaterThan(trigger.x + trigger.width);
      for (const tool of ["fetch_daily", "upsert_price", "post_alert"]) {
        const box = (await node(page, `tool:${tool}`).boundingBox())!;
        expect(box.y).toBeGreaterThan(trigger.y + trigger.height);
      }
    });

    test("hovering a tool lights the steps that call it, and a step lights its tool", async ({
      page,
    }) => {
      await fitAll(page);
      const linked = page.locator(".react-flow__node.md3-node--linked");
      await expect(linked).toHaveCount(0);

      await node(page, "tool:fetch_daily").hover();
      await expect(linked).toHaveCount(1);
      await expect(node(page, "workflow:fetch")).toHaveClass(/md3-node--linked/);

      await page.mouse.move(2, 2);
      await expect(linked).toHaveCount(0);

      await node(page, "workflow:write").hover();
      await expect(linked).toHaveCount(1);
      await expect(node(page, "tool:upsert_price")).toHaveClass(/md3-node--linked/);
    });

    test("focusing a tool from the keyboard lights its steps too", async ({ page }) => {
      await node(page, "tool:post_alert").focus();
      await expect(node(page, "workflow:alert")).toHaveClass(/md3-node--linked/);
      await node(page, "workflow:report").focus();
      await expect(page.locator(".react-flow__node.md3-node--linked")).toHaveCount(0);
    });

    test("a line is named by its steps' labels, not internal ids", async ({ page }) => {
      const names = await page
        .locator(".react-flow__edge")
        .evaluateAll((edges) => edges.map((e) => e.getAttribute("aria-label") ?? ""));
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name).not.toMatch(/workflow:|agent:|tool:/);
      expect(names).toContain(
        "Line from the trigger to each_symbol. Press Enter to insert a step before each_symbol.",
      );
      expect(names).toContain(
        "Line from anomaly to report (else). Press Enter to insert a step before report.",
      );
    });
  });
}
