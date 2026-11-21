import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// KAM-283: the first Replay of the Support inbox template stops at "Approval required", so a newcomer meets the
// trust feature before anything is saved, instead of watching a run that skips it.

const PORT = 4387;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "support-triage");
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-demo-approval-"));
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

    test("the first Replay asks for approval, says what each button does, and the draft is saved on Approve", async ({
      page,
    }) => {
      await page.goto(URL);
      await page.getByTestId("run-button").click();

      const dialog = page.getByRole("dialog", { name: "Approval required" });
      await expect(dialog).toBeVisible({ timeout: 20000 });
      await expect(dialog.getByTestId("approval-step")).toContainText("review");
      await expect(dialog.getByTestId("approval-approve-outcome")).toContainText("draft_approved");
      await expect(dialog.getByTestId("approval-reject-outcome")).toContainText("stops here");

      await dialog.getByRole("button", { name: "Approve" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId("runbar-status")).toContainText(/completed/, {
        timeout: 20000,
      });
    });
  });
}
