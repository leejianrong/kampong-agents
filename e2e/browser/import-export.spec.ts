import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// KAM-207: Download as file and Import from file on the YAML view, in a real browser against `kampong dev`.
// Download is the spec's own text; an invalid file is shown with line numbers and writes nothing; a valid one
// is confirmed, then replaces the file. Checked at 1440x900 and 900x700.

const PORT = 4345;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let file: string;

const SPEC = `# Import and export
version: "1.0"
agent:
  id: first_agent
  name: First agent
  role: Support
  goal: Handle refunds.
  workflow:
    - step: parse
      action: extract the order
`;

const OTHER = `# From another place
version: "1.0"
agent:
  id: second_agent
  name: Second agent
  role: Support
  goal: Something else.
  workflow:
    - step: look
      action: look it up
    - step: answer
      action: answer
`;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-import-"));
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
  test(`Download and import at ${size.width}x${size.height}`, async ({ page }) => {
    writeFileSync(file, SPEC);
    await page.setViewportSize(size);
    await page.goto(URL);
    await expect(page.getByTestId("yaml-preview")).toContainText("first_agent");

    // The actions sit quietly in the YAML view's header, inside the viewport.
    const download = page.getByRole("button", { name: "Download as file" });
    await expect(download).toBeInViewport();
    await expect(page.getByRole("button", { name: "Import from file" })).toBeInViewport();

    // Download is the spec's own text.
    const [saved] = await Promise.all([page.waitForEvent("download"), download.click()]);
    expect(saved.suggestedFilename()).toBe("first_agent.yaml");
    const path = await saved.path();
    expect(readFileSync(path, "utf8")).toBe(SPEC);

    // An invalid file: line-numbered errors, nothing written, no Import button.
    await page.getByRole("button", { name: "Import from file" }).click();
    const panel = page.getByRole("region", { name: "Import from file" });
    await panel.getByLabel("File", { exact: true }).setInputFiles({
      name: "bad.yaml",
      mimeType: "text/yaml",
      buffer: Buffer.from(OTHER.replace("id: second_agent", "id: [unclosed")),
    });
    const alert = panel.getByRole("alert");
    await expect(alert).toContainText("Nothing was changed");
    await expect(alert).toContainText(/Line \d+:/);
    await expect(panel.getByRole("button", { name: "Import", exact: true })).toHaveCount(0);
    expect(readFileSync(file, "utf8")).toBe(SPEC);

    // A valid file: confirm, then it replaces the spec as written, comments included.
    await panel.getByLabel("File", { exact: true }).setInputFiles({
      name: "other.yaml",
      mimeType: "text/yaml",
      buffer: Buffer.from(OTHER),
    });
    await expect(panel).toContainText("other.yaml is valid (Second agent: 2 steps, 0 tools)");
    await panel.getByRole("button", { name: "Import", exact: true }).click();
    const confirm = panel.getByRole("group", { name: "Replace the current spec?" });
    await confirm.scrollIntoViewIfNeeded();
    await expect(
      confirm.getByRole("button", { name: "Replace the current spec" }),
    ).toBeInViewport();
    expect(readFileSync(file, "utf8")).toBe(SPEC); // nothing is written until confirmed
    await confirm.getByRole("button", { name: "Replace the current spec" }).click();
    await expect(page.getByTestId("yaml-preview")).toContainText("second_agent");
    expect(readFileSync(file, "utf8")).toBe(OTHER);
  });
}
