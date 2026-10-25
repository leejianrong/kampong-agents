import type { Page } from "@playwright/test";

// KAM-214: where each canvas action lives now. The run bar's menu holds the infrequent ones, the status bar the
// settings, the run bar Run. Specs open a panel by its old name through this one place.

const MENU: Record<string, string> = {
  "Add Tool": "Add tool",
  "Add Workflow Step": "Add step",
  "Edit Steps": "Edit steps",
  "Import YAML": "Import YAML",
  "Export YAML": "Export YAML",
};

const STATUS: Record<string, RegExp> = {
  "Spec Vars": /^Vars$/,
  Vars: /^Vars$/,
  "Set Guardrails": /^Guardrails$/,
  Guardrails: /^Guardrails$/,
  Trigger: /^Trigger$/,
  Secrets: /^Secrets/,
  Checks: /^Checks$/,
};

export async function chooseFromMenu(page: Page, item: string): Promise<void> {
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("menuitem", { name: MENU[item] ?? item, exact: true }).click();
}

/** Opens a panel by the name the toolbar button used to have. */
export async function openPanel(page: Page, name: string): Promise<void> {
  if (MENU[name]) return chooseFromMenu(page, name);
  const status = STATUS[name];
  if (status) {
    await page.getByRole("contentinfo").getByRole("button", { name: status }).click();
    return;
  }
  if (name === "Test Run") {
    await page.getByRole("button", { name: "Test Run", exact: true }).click();
    return;
  }
  throw new Error(`No canvas action named ${name}`);
}

/**
 * A workflow opens on its first steps (KAM-238), so a spec that clicks a step further along fits the whole
 * graph first with the canvas's Fit control. Cards are small at that zoom, but every one is on screen.
 */
export async function fitAll(page: Page): Promise<void> {
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(400);
}
