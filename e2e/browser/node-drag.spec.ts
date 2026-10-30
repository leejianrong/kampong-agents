import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// KAM-186 (ADR-0061): dragging a card in a real browser against `kampong dev`.
//  - Dropped on empty canvas, a card is pinned: the spec file is untouched, `.kampong/layout.json` records the
//    position, and the card is still there after a reload.
//  - Dropped on another step of its list, a step takes that step's place in the run order (the step-move
//    operation): the order in the file changes. A step that reads another one cannot go above it and the file
//    is left alone.
// Checked at 1440x900 and 900x700.

const PORT = 4376;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let file: string;
let layoutFile: string;

const SPEC = `# Drag on the canvas
version: "1.1"
agent:
  id: dragger
  name: Dragger
  role: Support
  goal: Arrange things.
  workflow:
    - step: alpha
      action: do the first thing
    - step: bravo
      action: do the second thing
    - step: charlie
      action: do the third thing
`;

// Only the trigger and the first three steps are in view when a workflow opens (ADR-0059), so the case that needs
// a reader and what it reads has its own three steps.
const SPEC_READS = `# Drag a step above what it reads
version: "1.1"
agent:
  id: dragger
  name: Dragger
  role: Support
  goal: Arrange things.
  workflow:
    - step: parse
      action: read the order
    - step: reply
      action: "answer using {{ parse.text }}"
    - step: tidy
      action: tidy up
`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-drag-"));
  file = join(dir, "agent.yaml");
  layoutFile = join(dir, ".kampong", "layout.json");
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

const node = (page: Page, step: string) =>
  page.locator(`.react-flow__node[data-id="workflow:${step}"]`);

/** Where a card is in the canvas's own coordinates (React Flow sets it as a translate), not on screen. */
async function flowPosition(page: Page, step: string): Promise<{ x: number; y: number }> {
  const transform = await node(page, step).evaluate((el) => (el as HTMLElement).style.transform);
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(transform);
  if (!m) throw new Error(`no translate in "${transform}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Drags a card so that its centre ends up at `to`. It is grabbed by its left end: at a readable zoom the card's own centre can be off screen. */
async function dragCard(page: Page, step: string, to: { x: number; y: number }) {
  const box = (await node(page, step).boundingBox())!;
  const grab = { x: box.x + 30, y: box.y + box.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(to.x - box.width / 2 + 30, to.y, { steps: 12 });
  await page.mouse.up();
}

const centre = async (page: Page, step: string) => {
  const box = (await node(page, step).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const order = (names: string[]) => {
  const text = readFileSync(file, "utf8");
  return names.map((n) => text.indexOf(`step: ${n}\n`));
};

/** A fresh spec and no layout file, then the canvas open on it. */
async function openWith(page: Page, spec: string, first: string) {
  writeFileSync(file, spec);
  rmSync(join(dir, ".kampong"), { recursive: true, force: true });
  await page.goto(URL);
  await expect(node(page, first)).toBeVisible();
  await stillOnScreen(page, first);
}

/** Waits for the opening fit to finish: a drag that starts while the view is still moving misses its target. */
async function stillOnScreen(page: Page, step: string) {
  let last = "";
  let steady = 0;
  for (let i = 0; i < 60 && steady < 4; i++) {
    const now = JSON.stringify(await node(page, step).boundingBox());
    steady = now === last ? steady + 1 : 0;
    last = now;
    await page.waitForTimeout(100);
  }
}

const layout = () => JSON.parse(readFileSync(layoutFile, "utf8"));

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test.describe(`at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });
    test.beforeEach(async ({ page }) => {
      await openWith(page, SPEC, "alpha");
    });

    test("a card dropped on empty canvas is pinned: layout.json has it, the spec is untouched, and it survives a reload", async ({
      page,
    }) => {
      // The layout is stamped on first load; drop nothing yet.
      expect(existsSync(layoutFile)).toBe(true);
      const before = await flowPosition(page, "bravo");
      const start = await centre(page, "bravo");

      // Empty canvas: well below the row of cards.
      await dragCard(page, "bravo", { x: start.x, y: start.y + 190 });

      await expect
        .poll(async () => (await flowPosition(page, "bravo")).y, { timeout: 5000 })
        .toBeGreaterThan(before.y + 100);
      const moved = await flowPosition(page, "bravo");

      // Saved in the sidecar, as a pin, at the position the card was dropped at; the spec file is untouched.
      await expect.poll(() => layout()["workflow:bravo"]?.pinned).toBe(true);
      expect(layout()["workflow:bravo"]).toMatchObject({
        x: Math.round(moved.x),
        y: Math.round(moved.y),
      });
      expect(readFileSync(file, "utf8")).toBe(SPEC);
      // The other cards were not pinned.
      expect(layout()["workflow:alpha"].pinned).toBeUndefined();

      await page.reload();
      await expect(node(page, "bravo")).toBeVisible();
      await stillOnScreen(page, "bravo");
      expect(await flowPosition(page, "bravo")).toEqual({
        x: Math.round(moved.x),
        y: Math.round(moved.y),
      });
      expect(await flowPosition(page, "alpha")).toEqual({ x: before.x - 320, y: before.y });
    });

    test("a step dropped on another step takes its place in the run order, and the file changes", async ({
      page,
    }) => {
      // `charlie` onto `alpha`: it becomes the first step.
      await dragCard(page, "charlie", await centre(page, "alpha"));
      await expect
        .poll(() => {
          const [alpha, bravo, charlie] = order(["alpha", "bravo", "charlie"]);
          return charlie! < alpha! && alpha! < bravo!;
        })
        .toBe(true);
      expect(readFileSync(file, "utf8")).toContain("# Drag on the canvas");

      // After the reload the cards sit in run order, in their automatic places, with no pin on the moved one.
      await page.reload();
      await expect(node(page, "charlie")).toBeVisible();
      await stillOnScreen(page, "charlie");
      const first = await flowPosition(page, "charlie");
      const second = await flowPosition(page, "alpha");
      expect(first.x).toBeLessThan(second.x);
      expect(layout()["workflow:charlie"].pinned).toBeUndefined();
    });

    test("a step cannot be dropped above one it reads: the file is left alone and the card goes back", async ({
      page,
    }) => {
      await openWith(page, SPEC_READS, "parse");
      const before = readFileSync(file, "utf8");
      const home = await flowPosition(page, "reply");
      // `reply` reads `parse`, so `parse` cannot take `reply`'s place (it would run after its reader).
      await dragCard(page, "parse", await centre(page, "reply"));
      await expect(page.getByText(/"parse" was not moved/)).toBeVisible();
      expect(readFileSync(file, "utf8")).toBe(before);
      await expect.poll(async () => flowPosition(page, "reply")).toEqual(home);
      expect(layout()["workflow:parse"].pinned).toBeUndefined();
    });

    test("there is no lock control on the canvas controls", async ({ page }) => {
      await expect(page.locator(".react-flow__controls")).toBeVisible();
      await expect(page.locator(".react-flow__controls-interactive")).toHaveCount(0);
    });
  });
}
