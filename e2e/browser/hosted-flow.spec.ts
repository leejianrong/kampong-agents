import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { TOOL_APPROVAL_SPEC } from "./harness/fixtures.js";

// Browser E2E (KAN-1228 follow-up): the whole hosted flow driven through the
// real canvas UI in a headless browser -- sign up, create a workspace, store a
// (fake) BYOK key, open a spec on the canvas, edit it, run it, approve the HITL
// pause, and see the completed trace. Doubles as the screenshot source for the
// docs (KAN-1390): set SCREENSHOT_DIR to capture the canvas states.
//
// The harness server (harness/server.ts) wires the deterministic `createModel`
// seam, so the run pauses at `issue_refund`'s approval gate and completes on
// approve with no network. See playwright.config.ts for how it's started and
// the throwaway-Postgres requirement.

const SCREENSHOT_DIR = process.env["SCREENSHOT_DIR"] ?? join("e2e", "browser", "screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`), fullPage: false });
}

test("sign up -> workspace -> BYOK -> open, edit, run, approve a spec on the canvas", async ({
  page,
}) => {
  const email = `e2e-${randomUUID()}@example.com`;
  const password = "correct-horse-battery-staple";

  // 1. The app probes the server as hosted and shows the login gate.
  await page.goto("/");
  await expect(page.getByTestId("auth-screen")).toBeVisible();
  await shot(page, "01-login");

  // 2. Switch to sign-up and create an account.
  await page.getByTestId("auth-toggle").click();
  await page.getByLabel("Name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();

  // 3. No workspace yet -> create one.
  await expect(page.getByTestId("workspace-screen")).toBeVisible();
  await page.getByLabel("New workspace name").fill("Acme Support");
  await page.getByRole("button", { name: "Create workspace" }).click();

  // 4. Land on the (empty) spec list.
  await expect(page.getByTestId("spec-list-empty")).toBeVisible();
  await shot(page, "02-spec-list-empty");

  // 5. Store a (fake) BYOK key via the key-management screen.
  await page.getByTestId("nav-byok").click();
  await expect(page.getByTestId("byok-screen")).toBeVisible();
  await page.getByLabel("Provider").selectOption("openrouter");
  await page.getByLabel("API key").fill("sk-fake-e2e-key-abcd");
  await page.getByRole("button", { name: "Save key" }).click();
  // The key comes back masked -- only the last four are ever shown.
  await expect(page.getByTestId("byok-list")).toContainText("openrouter");
  await expect(page.getByTestId("byok-list")).toContainText("abcd");
  await shot(page, "03-byok");
  await page.getByTestId("byok-back").click();

  // 6. Seed the approval spec through the API (shares the browser's session
  // cookie), then reload so the spec list shows it.
  const created = await page.request.post("/api/specs", {
    data: { name: "Refund Agent", source: TOOL_APPROVAL_SPEC },
  });
  expect(created.ok()).toBeTruthy();
  await page.reload();

  // 7. Open it on the canvas.
  await expect(page.getByTestId("spec-list")).toBeVisible();
  await page.getByRole("button", { name: /Refund Agent/ }).click();
  await expect(page.getByText(/Trigger: Refund Agent/)).toBeVisible();
  await shot(page, "04-canvas-editor");

  // 8. Edit the spec on the canvas: add a tool via the structured form.
  await page.getByRole("button", { name: "Add Tool" }).click();
  const toolForm = page.getByRole("form", { name: "Add Tool" });
  await toolForm.getByLabel("Name").fill("lookup_customer");
  await toolForm.getByLabel("URL").fill("https://api.example.test/customers");
  await toolForm.getByRole("button", { name: "Save Tool" }).click();
  // The YAML preview (light viewer, ADR-0008) reflects the mutation.
  await expect(page.getByTestId("yaml-preview")).toContainText("lookup_customer");

  // 9. Run it. The condition routes to the requires_approval tool, so the run
  // pauses at the HITL gate.
  await page.getByRole("button", { name: "Test Run" }).click();
  await page.getByTestId("run-panel").getByLabel("Input").fill("Refund order #1");
  await page.getByTestId("run-panel").getByRole("button", { name: "Run" }).click();

  const approvalDialog = page.getByRole("dialog", { name: "Approval required" });
  await expect(approvalDialog).toBeVisible({ timeout: 20_000 });
  await shot(page, "05-approval");

  // 10. Approve -> the run completes and the trace is shown.
  await approvalDialog.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("run-status")).toContainText("completed", { timeout: 20_000 });
  await expect(page.getByTestId("run-trace")).toContainText("decide");
  await shot(page, "06-run-completed");
});
