import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// KAM-174: Move up / Move down on the step rows of Edit Steps, in a real browser against `kampong dev`. The order
// changes in the file; a move that would put a step before one it reads is refused in words and the file is left
// alone. Checked at 1440x900 and 900x700, where the docked panel is short.

const PORT = 4344;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let file: string;

const SPEC = `# Reorder from the canvas
version: "1.1"
agent:
  id: refunds
  name: Refund agent
  role: Support
  goal: Handle refunds.
  workflow:
    - step: parse
      action: extract the order
    - step: reply
      action: "answer using {{ parse.text }}"
    - step: loop
      foreach:
        items: trigger.items
        as: item
        steps:
          - step: scratch
            type: transform
            set:
              n: item.id
          - step: keep
            type: transform
            set:
              m: scratch.n
`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-move-"));
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
  server.kill();
  rmSync(dir, { recursive: true, force: true });
});

const order = (names: string[]) => {
  const text = readFileSync(file, "utf8");
  return names.map((n) => text.indexOf(`step: ${n}\n`));
};

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test(`Move at ${size.width}x${size.height}: order changes, a move that breaks a read is refused`, async ({
    page,
  }) => {
    writeFileSync(file, SPEC);
    await page.setViewportSize(size);
    await page.goto(URL);
    await openPanel(page, "Edit Steps");

    // The first row of a list cannot go up, and says why.
    const first = page.getByRole("button", { name: "Move step parse up", exact: true });
    await expect(first).toBeDisabled();
    await expect(first).toHaveAttribute("title", "Already first in its list");
    await expect(
      page.getByRole("button", { name: "Move step keep down", exact: true }),
    ).toBeDisabled();

    // A step nothing depends on moves: here `loop` goes above `reply`.
    await page.getByRole("button", { name: "Move step loop up", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Move step loop down", exact: true }),
    ).toBeEnabled();
    const [parse, reply, loop] = order(["parse", "reply", "loop"]);
    expect(parse).toBeLessThan(loop);
    expect(loop).toBeLessThan(reply);

    // Inside the loop body: `keep` reads `scratch`, so `keep` cannot go above it.
    const before = readFileSync(file, "utf8");
    await page.getByRole("button", { name: "Move step keep up", exact: true }).click();
    const alert = page.getByRole("alert").filter({ hasText: "was not moved" });
    await expect(alert).toContainText(
      '"keep" reads "scratch", so "scratch" has to stay before it.',
    );
    await alert.scrollIntoViewIfNeeded();
    await expect(alert).toBeInViewport();
    expect(await alert.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
    await alert.getByRole("button", { name: "OK" }).click();

    // `reply` reads `parse`, so `parse` cannot move below it.
    await page.getByRole("button", { name: "Move step parse down", exact: true }).click();
    await page.getByRole("button", { name: "Move step parse down", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "was not moved" })).toContainText(
      '"reply" reads "parse"',
    );
    expect(readFileSync(file, "utf8")).toContain("# Reorder from the canvas");
  });
}
