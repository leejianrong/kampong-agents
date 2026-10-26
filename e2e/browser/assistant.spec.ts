import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// KAM-250: prompt to applied steps in a real browser, against `kampong dev` and a fake OpenAI-compatible server.
// Asking changes nothing; Apply adds the cards (marked New) and writes the file; one Undo puts it back. At 900x700
// and 1440x900, with axe on the panel and no sideways scroll.

const PORT = 4372;
const LLM_PORT = 4373;
const URL = `http://127.0.0.1:${PORT}`;
const SPEC = `version: "1.1"
agent:
  id: demo
  name: Demo
  role: Analyst
  goal: Report.
  tools:
    - name: fetch_page
      action: http_request
      method: GET
      url: "https://example.test/page"
  workflow:
    - step: get
      type: tool
      tool: fetch_page
`;
const PLAN = {
  summary: "Adds a step that summarizes the page.",
  edits: [
    {
      kind: "add_step",
      step: { step: "summarize", action: "summarize_page", query: "Summarize {{ get.body }}" },
    },
  ],
};

let server: ChildProcess;
let llm: Server;
let dir: string;
const received: string[] = [];

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kampong-assistant-"));
  writeFileSync(join(dir, "agent.yaml"), SPEC);
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

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const onDisk = () => readFileSync(join(dir, "agent.yaml"), "utf8");

async function expectClean(page: Page, where: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  const blocking = results.violations
    .filter((v) => v.impact === "critical" || v.impact === "serious" || v.impact === "moderate")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(blocking, where).toEqual([]);
}

for (const size of [
  { width: 900, height: 700 },
  { width: 1440, height: 900 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });
    test.beforeEach(async ({ page }) => {
      writeFileSync(join(dir, "agent.yaml"), SPEC);
      received.length = 0;
      await page.goto(URL);
      await expect(node(page, "workflow:get")).toBeVisible();
      // Narrow windows start with the rail folded to buttons; wide ones with it open.
      await page.getByRole("button", { name: /^(Build with the assistant|Assistant)$/ }).click();
      await expect(page.getByTestId("assistant-panel")).toBeVisible();
    });

    test("a prompt becomes a plan, Apply adds the step as New, and one Undo puts the file back", async ({
      page,
    }) => {
      const panel = page.getByTestId("assistant-panel");
      await expect(page.getByTestId("assistant-notice")).toContainText(`127.0.0.1:${LLM_PORT}`);

      await panel.getByLabel("Describe a change").fill("summarize the page after fetching it");
      await panel.getByLabel("Describe a change").press("Enter");
      const plan = panel.getByLabel("Proposed plan");
      await expect(plan).toContainText("Adds a step that summarizes the page.");
      await expect(plan).toContainText("summarize");

      // Asking changed nothing: not the canvas, not the file; and what went out holds the workflow and the prompt.
      await expect(node(page, "workflow:summarize")).toHaveCount(0);
      expect(onDisk()).toBe(SPEC);
      expect(received).toHaveLength(1);
      expect(received[0]).toContain("fetch_page");
      expect(received[0]).toContain("summarize the page after fetching it");
      await expectClean(page, "the assistant with a plan");

      await panel.getByRole("button", { name: "Apply to canvas" }).click();
      await expect(panel).toContainText("Applied: 1 change");
      await expect(node(page, "workflow:summarize")).toBeVisible();
      await expect(node(page, "workflow:summarize").getByTestId("card-new")).toHaveText("New");
      expect(onDisk()).toContain("summarize_page");
      await expectClean(page, "the assistant after Apply");

      await panel.getByRole("button", { name: "Undo" }).click();
      await expect(panel).toContainText("Undone");
      await expect(node(page, "workflow:summarize")).toHaveCount(0);
      expect(onDisk()).toBe(SPEC);
    });

    test("fits: no sideways scroll with the panel open, and the form stays in view", async ({
      page,
    }) => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const send = page.getByTestId("assistant-panel").getByRole("button", { name: "Send" });
      await expect(send).toBeInViewport();
      await page.getByRole("button", { name: "Steps", exact: true }).click();
      await expect(page.getByTestId("step-palette")).toBeVisible();
    });
  });
}
