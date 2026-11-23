import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// KAM-312: pressing Save on a bad trigger shows the message in full, above the Save bar, without scrolling.

const PORT = 4387;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "market-etl");
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-trigger-errors-"));
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

const CASES = [
  { name: "an empty cron", cron: "", tz: "", message: /cron/i },
  { name: "minute 99", cron: "99 * * * *", tz: "", message: /99/ },
  { name: "an unknown time zone", cron: "0 9 * * 1-5", tz: "Mars/Phobos", message: /Mars\/Phobos/ },
];

for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    for (const c of CASES) {
      test(`${c.name}: the message shows without scrolling, clear of the Save bar`, async ({
        page,
      }) => {
        await page.goto(URL);
        await openPanel(page, "Trigger");
        await page.getByRole("button", { name: "Edit trigger" }).click();
        await page.getByRole("textbox", { name: /^Cron/ }).fill(c.cron);
        await page.getByRole("textbox", { name: /^Time zone/ }).fill(c.tz);
        await page.getByRole("button", { name: "Save trigger" }).click();
        const alert = page.getByRole("alert").filter({ hasText: c.message });
        await expect(alert).toBeVisible();
        await expect(alert).toBeInViewport({ ratio: 1 });
        // Not hidden behind the Save button.
        const box = (await alert.boundingBox())!;
        const save = (await page.getByRole("button", { name: "Save trigger" }).boundingBox())!;
        expect(box.y + box.height).toBeLessThanOrEqual(save.y + 1);
      });
    }
  });
}
