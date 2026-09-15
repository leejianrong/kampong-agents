import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { TOOL_APPROVAL_SPEC } from "./harness/fixtures.js";

// Captures the canvas screenshots the docs (KAN-1390) embed. Skipped in CI --
// it writes committed PNGs under docs/assets/img, so it's run deliberately,
// locally, against the same throwaway Postgres harness the flow E2E uses:
//   CAPTURE_DOCS=1 DATABASE_URL=postgres://app_test:app_test@localhost:15434/kampong_e2e \
//     npx playwright test docs-screenshots
// Then commit the refreshed images. Kept as a .spec so it reuses the harness
// webServer + fixtures rather than duplicating the boot wiring.

const OUT = join("docs", "assets", "img");

test.skip(!process.env["CAPTURE_DOCS"], "set CAPTURE_DOCS=1 to (re)capture docs screenshots");

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

test("capture docs screenshots", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  const email = `docs-${randomUUID()}@example.com`;

  await page.goto("/");
  await expect(page.getByTestId("auth-screen")).toBeVisible();
  await shot(page, "hosted-login");

  await page.getByTestId("auth-toggle").click();
  await page.getByLabel("Name").fill("Docs Demo");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: "Sign up" }).click();

  await expect(page.getByTestId("workspace-screen")).toBeVisible();
  await shot(page, "hosted-workspace");
  await page.getByLabel("New workspace name").fill("Acme Support");
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(page.getByTestId("spec-list-empty")).toBeVisible();
  await shot(page, "hosted-spec-list-empty");

  // BYOK key management.
  await page.getByTestId("nav-byok").click();
  await expect(page.getByTestId("byok-screen")).toBeVisible();
  await page.getByLabel("Provider").selectOption("openrouter");
  await page.getByLabel("API key").fill("sk-fake-demo-key-abcd");
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByTestId("byok-list")).toContainText("openrouter");
  await shot(page, "hosted-byok");
  await page.getByTestId("byok-back").click();

  // Seed a spec and open it on the canvas.
  const created = await page.request.post("/api/specs", {
    data: { name: "Refund Agent", source: TOOL_APPROVAL_SPEC },
  });
  expect(created.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: /Refund Agent/ }).click();
  await expect(page.getByText(/Trigger: Refund Agent/)).toBeVisible();
  await shot(page, "canvas-editor");

  // The Add Tool form open on the canvas.
  await page.getByRole("button", { name: "Add Tool" }).click();
  await expect(page.getByRole("form", { name: "Add Tool" })).toBeVisible();
  await shot(page, "canvas-add-tool");
  await page.getByRole("button", { name: "Cancel" }).click();

  // The Set Guardrails form open on the canvas.
  await page.getByRole("button", { name: "Set Guardrails" }).click();
  await shot(page, "canvas-guardrails");
  await page.getByRole("button", { name: "Cancel" }).click();

  // Run -> approval modal -> completed trace (run panel docked in the side pane).
  await page.getByRole("button", { name: "Test Run" }).click();
  await page.getByTestId("run-panel").getByLabel("Input").fill("Refund order #1");
  await page.getByTestId("run-panel").getByRole("button", { name: "Run" }).click();
  const approvalDialog = page.getByRole("dialog", { name: "Approval required" });
  await expect(approvalDialog).toBeVisible({ timeout: 20_000 });
  await shot(page, "run-approval");
  await approvalDialog.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("run-status")).toContainText("completed", { timeout: 20_000 });
  await shot(page, "run-completed");
});
