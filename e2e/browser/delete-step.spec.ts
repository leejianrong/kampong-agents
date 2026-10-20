import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// KAM-171: Delete on the step and tool rows of Edit Steps, in a real browser against `kampong dev`. A step
// something reads, and a tool a step uses, show what blocks them and stay; a step nothing reads is confirmed,
// then goes from the canvas and the file. Checked at 1440x900 and 900x700, where the docked panel is short.

const PORT = 4342;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let file: string;

const SPEC = `# Delete from the canvas
version: "1.1"
agent:
  id: refunds
  name: Refund agent
  role: Support
  goal: Handle refunds.
  tools:
    - name: lookup
      action: http_request
      method: GET
      url: "https://api.example.com/orders"
  workflow:
    - step: parse
      action: extract the order
    - step: reply
      action: "answer using {{ parse.text }}"
    - step: call
      type: tool
      tool: lookup
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
              m: item.name
`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-delete-"));
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

for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 700 },
]) {
  test(`Delete at ${size.width}x${size.height}: references block, an unused step goes`, async ({
    page,
  }) => {
    writeFileSync(file, SPEC);
    await page.setViewportSize(size);
    await page.goto(URL);
    await openPanel(page, "Edit Steps");

    // A step that is read: the list comes first, the file is untouched, and the text fits the panel.
    await page.getByRole("button", { name: "Delete step parse", exact: true }).click();
    await page.getByRole("button", { name: "Delete step", exact: true }).click();
    const alert = page.getByRole("alert").filter({ hasText: "cannot be deleted yet" });
    await expect(alert).toContainText('1 place uses step "parse"');
    await expect(alert).toContainText('step "reply"');
    await alert.scrollIntoViewIfNeeded();
    await expect(alert).toBeInViewport();
    expect(await alert.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(SPEC);
    await alert.getByRole("button", { name: "OK" }).click();

    // A tool a step uses is blocked the same way.
    await page.getByRole("button", { name: "Delete tool lookup", exact: true }).click();
    await page.getByRole("button", { name: "Delete tool", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: 'uses tool "lookup"' })).toContainText(
      'step "call"',
    );
    await page.getByRole("alert").getByRole("button", { name: "OK" }).click();

    // A step inside a loop that nothing reads: confirm, then it is gone from the list and the file.
    await page.getByRole("button", { name: "Delete step scratch", exact: true }).click();
    const confirm = page.getByRole("group", { name: "Delete step scratch?" });
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm.getByRole("button", { name: "Delete step" })).toBeInViewport();
    expect(readFileSync(file, "utf8")).toBe(SPEC); // nothing is written until the confirm
    await confirm.getByRole("button", { name: "Delete step" }).click();
    await expect(page.getByRole("button", { name: "Delete step scratch" })).toHaveCount(0);
    const written = readFileSync(file, "utf8");
    expect(written).not.toContain("scratch");
    expect(written).toContain("# Delete from the canvas");
  });
}
