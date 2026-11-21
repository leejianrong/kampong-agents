import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// KAM-281: typing an input that has no recording into a Replay run is a dead end unless the screen says so in
// plain words and offers a way out. No flag, file path or hash is shown until the detail is opened.

const PORT = 4379;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "support-triage");
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-missing-"));
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

for (const size of [
  { width: 900, height: 700 },
  { width: 1440, height: 900 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test("an input with no recording says so, offers Run live and Clear the input, and hides the CLI text", async ({
      page,
    }) => {
      await page.goto(URL);
      await page.getByRole("button", { name: "Test Run", exact: true }).click();
      await page.getByRole("textbox").first().fill("Hi, my order never arrived.");
      await page.getByTestId("run-button").click();

      const halted = page.getByTestId("run-halted");
      await expect(halted).toContainText("no recorded answer, so Replay cannot run it", {
        timeout: 20000,
      });
      // The words on screen carry no flag, path or hash; the raw message is inside the closed details.
      const raw = halted.locator("details");
      await expect(raw).not.toHaveAttribute("open", "");
      await expect(halted.locator("p")).not.toContainText(/--tools|fixtures|\.json/);
      await expect(halted.getByRole("button", { name: "Run live" })).toBeVisible();

      await halted.getByRole("button", { name: "Clear the input" }).click();
      await expect(page.getByRole("textbox").first()).toHaveValue("");
    });
  });
}
