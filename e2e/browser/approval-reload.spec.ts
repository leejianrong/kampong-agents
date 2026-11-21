import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// KAM-280: a run waiting for a person's decision is still there after the page is reloaded: the dialog is back,
// and the decision goes to the same run.

const PORT = 4377;
const URL = `http://127.0.0.1:${PORT}`;
const SPEC = `version: "1.1"
agent:
  id: approver
  name: Approver
  role: Checker
  goal: Wait for a person.
  workflow:
    - step: shape
      type: transform
      set:
        ok: "true"
    - step: ok_to_send
      type: approval
      message: "Send it?"
`;
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-approval-"));
  writeFileSync(join(dir, "agent.yaml"), SPEC);
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

    test("a pending approval is back after a reload and can be approved", async ({ page }) => {
      await page.goto(URL);
      await page.getByTestId("run-button").click();
      const dialog = page.getByRole("dialog", { name: "Approval required" });
      await expect(dialog).toBeVisible({ timeout: 20000 });
      // KAM-284: it names the step and says what each button does.
      await expect(dialog.getByTestId("approval-step")).toContainText("ok_to_send");
      await expect(dialog.getByTestId("approval-reject-outcome")).toContainText("stops here");

      await page.reload();
      await expect(dialog).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId("runbar-status")).toContainText("waiting for approval");

      await dialog.getByRole("button", { name: "Approve" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId("runbar-status")).toContainText(/completed|Finished/, {
        timeout: 20000,
      });

      // Decided, so nothing is waiting any more: a second reload finds no dialog.
      await page.reload();
      await expect(page.getByTestId("run-button")).toBeEnabled();
      await expect(page.getByRole("dialog", { name: "Approval required" })).toHaveCount(0);
    });
  });
}
