import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openPanel } from "./harness/bars.js";

// KAM-289: `kampong dev` does not fire a schedule, webhook or poll by itself, so a workflow with a trigger says so,
// in the Trigger panel and on the status bar chip, with a link to how to deploy it.

const PORT = 4386;
const URL = `http://127.0.0.1:${PORT}`;
const TEMPLATE = join("packages", "cli", "templates", "market-etl");
let server: ChildProcess;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-trigger-note-"));
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

    test("the Trigger panel says the trigger does not run by itself here, and links to deploying it", async ({
      page,
    }) => {
      await page.goto(URL);
      await openPanel(page, "Trigger");
      const note = page.getByTestId("trigger-local-note");
      await expect(note).toContainText("only when you press Run");
      await expect(note.getByRole("link", { name: /deploy/i })).toHaveAttribute(
        "href",
        /kampong-serve/,
      );
      await expect(
        page.getByRole("contentinfo").getByRole("button", { name: /^Trigger/ }),
      ).toHaveAttribute("title", /Not running here/);
    });
  });
}
