import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// KAM-205: an empty folder and one description give a valid workflow that runs in Replay. The description goes in
// the empty state's box; a blank workflow is started and the assistant's plan is shown for review; Apply builds it.
// The plan here calls nothing outside itself, so Replay is open to it with no recorded data and no keys.

const PORT = 4374;
const LLM_PORT = 4375;
const URL = `http://127.0.0.1:${PORT}`;
const PLAN = {
  summary: "Adds two numbers and checks the answer.",
  edits: [
    { kind: "upgrade_to_1_1" },
    {
      kind: "set_agent",
      fields: { name: "Quick sum", role: "Calculator", goal: "Add two numbers and check them." },
    },
    { kind: "add_step", step: { step: "shape", type: "transform", set: { total: "1 + 2" } } },
    {
      kind: "add_step",
      step: { step: "check", type: "validate", assert: "shape.total = 3", message: "wrong sum" },
    },
    { kind: "remove_step", step: "answer" },
  ],
};

let server: ChildProcess;
let llm: Server;
let dir: string;
const received: string[] = [];

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-assistant-new-"));
  llm = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      received.push(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(PLAN) } }] }));
    });
  });
  await new Promise<void>((resolve) => llm.listen(LLM_PORT, "127.0.0.1", resolve));
  server = spawn(
    process.execPath,
    [join("packages", "cli", "dist", "cli.js"), "dev", dir, "--port", String(PORT)],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        KAMPONG_ASSISTANT_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
        KAMPONG_ASSISTANT_MODEL: "fake-model",
      },
    },
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

test.afterAll(async () => {
  server?.kill();
  await new Promise((resolve) => llm?.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

for (const size of [
  { width: 900, height: 700 },
  { width: 1440, height: 900 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test("a description on the empty canvas becomes a workflow that runs in Replay", async ({
      page,
    }) => {
      const file = join(dir, "agent.yaml");
      rmSync(file, { force: true });
      rmSync(join(dir, ".kampong"), { recursive: true, force: true });
      received.length = 0;
      await page.goto(URL);

      const box = page.getByLabel("Or describe what you want to build");
      await expect(page.getByTestId("empty-state-prompt")).toContainText(`127.0.0.1:${LLM_PORT}`);
      await box.fill("add 1 and 2 and check the answer is 3");
      await box.press("Enter");

      // The plan is shown for review; the blank workflow it will change is all that is on disk.
      const panel = page.getByTestId("assistant-panel");
      const plan = panel.getByLabel("Proposed plan");
      await expect(plan).toContainText("Adds two numbers and checks the answer.");
      expect(received).toHaveLength(1);
      expect(received[0]).toContain("add 1 and 2 and check the answer is 3");
      expect(readFileSync(file, "utf8")).toContain("step: answer");
      expect(readFileSync(file, "utf8")).not.toContain("shape");

      await panel.getByRole("button", { name: "Apply to canvas" }).click();
      await expect(panel).toContainText("Applied");
      const onDisk = readFileSync(file, "utf8");
      expect(onDisk).toContain('version: "1.1"');
      expect(onDisk).toContain("step: shape");
      expect(onDisk).not.toContain("step: answer");
      await expect(
        page.locator('.react-flow__node[data-id="workflow:shape"]').getByTestId("card-new"),
      ).toBeVisible();

      // With nothing to record, Replay is open, and it runs with no keys and no recorded data.
      await expect(
        page.getByTestId("run-controls").getByRole("button", { name: "Replay" }),
      ).toHaveAttribute("aria-pressed", "true");
      await page.getByTestId("run-button").click();
      await expect(page.getByTestId("runbar-status")).toContainText("completed", {
        timeout: 20000,
      });
      expect(existsSync(join(dir, ".kampong", "fixtures"))).toBe(false);
    });
  });
}
