import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// KAM-303: at a phone's width the outcome banner wraps instead of cutting off the reason, the Close control is
// fully on screen, and the list starts at its top.

const PORT = 4389;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "market-etl");
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-runlog-phone-"));
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

test.describe("390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the whole reason is readable, Close is inside the screen and the list starts at its top", async ({
    page,
  }) => {
    await page.goto(URL);
    await page.getByTestId("run-button").click();
    const banner = page.getByTestId("run-log-outcome");
    await expect(banner).toContainText("Finished", { timeout: 20000 });

    // Nothing in the banner is cut off: it is not wider than its box, and it is not clipped by an ellipsis.
    const clipped = await banner.evaluate((el) => ({
      wide: el.scrollWidth > el.clientWidth + 1,
      tall: el.scrollHeight > el.clientHeight + 1,
      nowrap: getComputedStyle(el).whiteSpace === "nowrap",
    }));
    expect(clipped).toEqual({ wide: false, tall: false, nowrap: false });
    const text = (await banner.textContent()) ?? "";
    expect(text.length).toBeGreaterThan(20);
    expect((await banner.boundingBox())!.height).toBeGreaterThan(36);

    const close = (await page.getByRole("button", { name: "Close run log" }).boundingBox())!;
    expect(close.x).toBeGreaterThanOrEqual(0);
    expect(close.x + close.width).toBeLessThanOrEqual(390);

    // The page and the sheet are not scrolled, and the list reads from the failed row it selected, which is on screen.
    expect(await page.locator(".md3-runlog__body").evaluate((el) => el.scrollTop)).toBe(0);
    const list = (await page.locator(".md3-runlog__rows").boundingBox())!;
    const failed = page.locator('.md3-runlog__row[data-row-status="failed"]').first();
    await expect(failed).toBeInViewport();
    expect((await failed.boundingBox())!.y - list.y).toBeLessThan(60);
  });
});
