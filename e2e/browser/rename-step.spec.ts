import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// KAM-172: Rename on the step and tool rows of Edit Steps, in a real browser against `kampong dev`. Every use of
// the name is rewritten in one save; a name that is taken is refused next to the field with the input kept.
// Checked at 1440x900 and 900x700, where the docked panel is short.

const PORT = 4343;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let file: string;

const SPEC = `# Rename from the canvas
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
              n: parse.id
          - step: keep
            type: transform
            set:
              m: scratch.n
`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-rename-"));
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
  test(`Rename at ${size.width}x${size.height}: a taken name is refused, a free one rewrites every use`, async ({
    page,
  }) => {
    writeFileSync(file, SPEC);
    await page.setViewportSize(size);
    await page.goto(URL);
    await page.getByRole("button", { name: "Edit Steps", exact: true }).click();

    // A taken name: refused in words, next to the field, input kept, file untouched.
    await page.getByRole("button", { name: "Rename step parse", exact: true }).click();
    const form = page.getByRole("form", { name: "Rename step parse?" });
    await expect(form).toContainText("2 places will be updated");
    await form.getByLabel("New name").fill("reply");
    await form.getByRole("button", { name: "Rename step", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText('"reply" is already used by another step');
    await expect(form.getByLabel("New name")).toHaveValue("reply");
    await expect(form.getByRole("button", { name: "Rename step", exact: true })).toBeInViewport();
    expect(readFileSync(file, "utf8")).toBe(SPEC);

    // A free name: every use is rewritten in one save, comments stay, the row shows the new name.
    await form.getByLabel("New name").fill("read_order");
    await form.getByRole("button", { name: "Rename step", exact: true }).click();
    await expect(page.getByRole("button", { name: "Rename step read_order" })).toBeVisible();
    expect(readFileSync(file, "utf8")).toBe(SPEC.replaceAll("parse", "read_order"));

    // A step inside a loop, and a tool a step uses.
    await page.getByRole("button", { name: "Rename step scratch", exact: true }).click();
    const inner = page.getByRole("form", { name: "Rename step scratch?" });
    await inner.getByLabel("New name").fill("tidy");
    await inner.getByRole("button", { name: "Rename step", exact: true }).click();
    await expect(page.getByRole("button", { name: "Rename step tidy" })).toBeVisible();

    await page.getByRole("button", { name: "Rename tool lookup", exact: true }).click();
    const tool = page.getByRole("form", { name: "Rename tool lookup?" });
    await expect(tool).toContainText("1 place will be updated");
    await tool.getByLabel("New name").fill("find_order");
    await tool.getByRole("button", { name: "Rename tool", exact: true }).click();
    await expect(page.getByRole("button", { name: "Rename tool find_order" })).toBeVisible();

    const written = readFileSync(file, "utf8");
    expect(written).toBe(
      SPEC.replaceAll("parse", "read_order")
        .replaceAll("scratch", "tidy")
        .replaceAll("lookup", "find_order"),
    );
  });
}
