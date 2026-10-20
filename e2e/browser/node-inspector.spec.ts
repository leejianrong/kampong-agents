import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// KAM-211: click a node to open its inspector (the matching form in the docked panel); Esc closes it, Delete
// removes the step or tool through the KAM-171 flow, Ctrl+D duplicates it. Real browser against `kampong dev`, at
// 1440x900 and 900x700.

const PORT = 4348;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let file: string;

const SPEC = `# Inspector fixture
version: "1.1"
agent:
  id: inspector
  name: Inspector agent
  role: Support
  goal: Handle refunds.
  trigger:
    type: schedule
    every: 1h
  guardrails:
    confidence_threshold: 0.6
    fallback_action: escalate_to_human
  tools:
    - name: lookup
      action: http_request
      method: GET
      url: "https://api.example.com/orders"
    - name: spare
      action: http_request
      method: GET
      url: "https://api.example.com/spare"
  workflow:
    - step: parse
      action: extract the order
    - step: call
      type: tool
      tool: lookup
    - step: shape
      type: transform
      set:
        n: "1"
    - step: check
      type: validate
      assert: "true"
    - step: once
      type: dedupe
      once:
        key: "trigger.id"
        ttl: 24h
    - step: loop
      foreach:
        items: trigger.items
        as: item
        steps:
          - step: scratch
            type: transform
            set:
              m: item.id
          - step: keep
            type: transform
            set:
              j: item.name
    - step: route
      branch:
        if: "true"
        then:
          - step: yes_arm
            stop:
              reason: done
        else:
          - step: no_arm
            type: transform
            set:
              k: "2"
    - step: ask
      type: approval
      message: ok?
`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-inspector-"));
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

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const inspector = (page: Page) => page.getByTestId("node-inspector");

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });
    test.beforeEach(async ({ page }) => {
      writeFileSync(file, SPEC);
      await page.goto(URL);
      await expect(node(page, "workflow:parse")).toBeVisible();
    });

    test("clicking a node opens the matching form, for every kind of node", async ({ page }) => {
      const cases: [string, string, string | RegExp][] = [
        ["workflow:parse", "Step parse", "Query"],
        ["workflow:call", "Step call", "Tool"],
        ["workflow:shape", "Step shape", "Values"],
        ["workflow:check", "Step check", "Assert (expression that must be true)"],
        ["workflow:once", "Step once", "Key (expression)"],
        ["workflow:loop", "Step loop", "Loop variable"],
        ["workflow:scratch", "Step scratch", "Values"],
        ["workflow:route", "Step route", /If \(expression/],
        ["workflow:yes_arm", "Step yes_arm", "Reason"],
        ["workflow:no_arm", "Step no_arm", "Values"],
        ["workflow:ask", "Step ask", "Message"],
        ["tool:lookup", "Tool lookup", "Name"],
        ["agent:inspector", "Trigger settings", "Schedule"],
        ["guardrails:inspector", "Guardrails", "Confidence threshold"],
      ];
      for (const [id, title, text] of cases) {
        await node(page, id).click({ position: { x: 8, y: 8 } });
        const panel = page.getByRole("region", { name: title, exact: true });
        await expect(panel, id).toBeVisible();
        await expect(panel.getByText(text).first(), id).toBeVisible();
        await expect(node(page, id)).toHaveClass(/selected/);
        await expect(inspector(page)).toHaveCount(1);
      }
      // The file was never touched by looking.
      expect(readFileSync(file, "utf8")).toBe(SPEC);
    });

    test("a node has an accessible name and Enter selects it from the keyboard", async ({
      page,
    }) => {
      await expect(node(page, "workflow:scratch")).toHaveAttribute(
        "aria-label",
        "Transform step scratch, in loop",
      );
      await node(page, "workflow:parse").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("region", { name: "Step parse", exact: true })).toBeFocused();
    });

    test("Esc closes the inspector and puts focus back on the node", async ({ page }) => {
      await node(page, "workflow:shape").click();
      await expect(inspector(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(inspector(page)).toHaveCount(0);
      await expect(node(page, "workflow:shape")).not.toHaveClass(/selected/);
      await expect(node(page, "workflow:shape")).toBeFocused();
    });

    test("clicking the empty canvas closes it", async ({ page }) => {
      await node(page, "workflow:shape").click();
      await expect(inspector(page)).toBeVisible();
      await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
      await expect(inspector(page)).toHaveCount(0);
    });

    test("saving a change from the inspector writes it and closes the panel", async ({ page }) => {
      await node(page, "workflow:check").click();
      await page.getByLabel("Message (optional)").fill("must hold");
      await page.getByRole("button", { name: "Save step" }).click();
      await expect(inspector(page)).toHaveCount(0);
      await expect.poll(() => readFileSync(file, "utf8")).toContain("must hold");
    });

    test("Delete removes a step after the confirm, and a step something reads is refused", async ({
      page,
    }) => {
      // `parse` is not read here, `call` reads `lookup`; deleting the tool is the refused one.
      await node(page, "tool:lookup").click();
      await page.keyboard.press("Delete");
      await page.getByRole("button", { name: "Delete tool", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: 'uses tool "lookup"' })).toContainText(
        'step "call"',
      );
      expect(readFileSync(file, "utf8")).toBe(SPEC);
      await page.getByRole("alert").getByRole("button", { name: "OK" }).click();

      await node(page, "workflow:scratch").click();
      await page.keyboard.press("Delete");
      const confirm = page.getByRole("group", { name: "Delete step scratch?" });
      await expect(confirm.getByRole("button", { name: "Delete step" })).toBeFocused();
      expect(readFileSync(file, "utf8")).toBe(SPEC); // nothing is written until the confirm
      await page.keyboard.press("Enter");
      await expect(node(page, "workflow:scratch")).toHaveCount(0);
      await expect(inspector(page)).toHaveCount(0);
      expect(readFileSync(file, "utf8")).not.toContain("scratch");
    });

    test("Delete on an unused tool removes it", async ({ page }) => {
      await node(page, "tool:spare").click();
      await page.getByRole("button", { name: "Delete tool spare", exact: true }).click();
      await page.getByRole("button", { name: "Delete tool", exact: true }).click();
      await expect(node(page, "tool:spare")).toHaveCount(0);
      expect(readFileSync(file, "utf8")).not.toContain("spare");
    });

    test("Ctrl+D duplicates a step in its own list under a new name and selects the copy", async ({
      page,
    }) => {
      await node(page, "workflow:scratch").click();
      await page.keyboard.press("Control+d");
      await expect(node(page, "workflow:scratch_copy")).toBeVisible();
      await expect(node(page, "workflow:scratch_copy")).toHaveClass(/selected/);
      await expect(
        page.getByRole("region", { name: "Step scratch_copy", exact: true }),
      ).toBeVisible();
      const written = readFileSync(file, "utf8");
      expect(written.indexOf("scratch_copy")).toBeGreaterThan(written.indexOf("step: scratch\n"));
      expect(written.indexOf("scratch_copy")).toBeLessThan(written.indexOf("step: route"));
      // Again: the next free name.
      await page.keyboard.press("Control+d");
      await expect(node(page, "workflow:scratch_copy_copy")).toBeVisible();
    });

    test("duplicate works from the button, for a tool and for a loop with its body", async ({
      page,
    }) => {
      await node(page, "tool:spare").click();
      await page.getByRole("button", { name: "Duplicate tool spare", exact: true }).click();
      await expect(node(page, "tool:spare_copy")).toBeVisible();

      await node(page, "workflow:loop").click();
      await page.getByRole("button", { name: "Duplicate step loop", exact: true }).click();
      await expect(node(page, "workflow:loop_copy")).toBeVisible();
      await expect(node(page, "workflow:scratch_copy")).toBeVisible();
    });

    test("unsaved input is not discarded silently when another node is clicked", async ({
      page,
    }) => {
      await node(page, "workflow:check").click();
      await page.getByLabel("Message (optional)").fill("half typed");
      await node(page, "workflow:shape").click();
      const prompt = page.getByTestId("discard-prompt");
      await expect(prompt).toContainText("changes you have not saved");
      // Still on the first form with the text in it.
      await expect(page.getByLabel("Message (optional)")).toHaveValue("half typed");
      await prompt.getByRole("button", { name: "Keep editing" }).click();
      await expect(prompt).toHaveCount(0);
      await expect(page.getByLabel("Message (optional)")).toHaveValue("half typed");

      // Esc asks too; Discard moves on.
      await page.keyboard.press("Escape");
      await expect(prompt).toBeVisible();
      await prompt.getByRole("button", { name: "Discard changes" }).click();
      await expect(inspector(page)).toHaveCount(0);
      expect(readFileSync(file, "utf8")).toBe(SPEC);

      // Discard on the way to another node opens that node.
      await node(page, "workflow:check").click();
      await page.getByLabel("Message (optional)").fill("again");
      await node(page, "workflow:shape").click();
      await page
        .getByTestId("discard-prompt")
        .getByRole("button", { name: "Discard changes" })
        .click();
      await expect(page.getByRole("region", { name: "Step shape", exact: true })).toBeVisible();
    });

    test("the toolbar buttons still open their forms, and replace the inspector", async ({
      page,
    }) => {
      await node(page, "workflow:shape").click();
      await page.getByRole("button", { name: "Edit Steps", exact: true }).click();
      await expect(page.getByTestId("steps-panel")).toBeVisible();
      await expect(inspector(page)).toHaveCount(0);
      await page.getByRole("button", { name: "Add Tool", exact: true }).click();
      await expect(page.getByRole("region", { name: "Add Tool", exact: true })).toBeVisible();
    });

    test("axe finds nothing new with a node selected and its inspector open", async ({ page }) => {
      await node(page, "workflow:parse").click();
      await expect(inspector(page)).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withRules([
          "scrollable-region-focusable",
          "aria-allowed-attr",
          "aria-valid-attr-value",
          "aria-required-children",
          "aria-required-parent",
          "button-name",
          "label",
          "nested-interactive",
        ])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });
}
