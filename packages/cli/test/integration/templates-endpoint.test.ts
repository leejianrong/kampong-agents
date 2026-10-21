import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { parseSpec } from "@kampong/spec";
import { createDevServer } from "../../src/server.js";
import { EXIT_SUCCESS, runCli } from "../../src/cli.js";
import { listTemplates } from "../../src/templates.js";
import { capture } from "../unit/test-helpers.js";

// KAM-216: the template gallery's two routes. GET /api/templates lists what ships with kampong; POST
// /api/spec/template saves one as the workflow, with its recorded fixtures where a replay run finds them.

const OTHER = `version: "1.0"
agent:
  id: mine
  name: Mine
  role: R
  goal: G
  workflow:
    - step: s
      action: say
`;

describe("the template gallery routes", () => {
  let dir: string;
  let specPath: string;
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-templates-api-"));
    specPath = join(dir, "agent.yaml");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await app?.close();
    app = undefined;
    rmSync(dir, { recursive: true, force: true });
  });
  const start = () => {
    app = createDevServer({ specPath, layoutPath: join(dir, ".kampong", "layout.json") });
    return app;
  };

  it("lists every template with a friendly title, a plain description, step kinds and the offline flag", async () => {
    const res = await start().inject({ method: "GET", url: "/api/templates" });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{
      name: string;
      title: string;
      description: string;
      stepKinds: string[];
      runsOffline: boolean;
      path?: string;
    }>;
    expect(list.map((t) => t.name)).toEqual(listTemplates().map((t) => t.name));
    expect(list.map((t) => t.name)).toEqual(
      expect.arrayContaining(["market-etl", "support-triage", "webhook-triage"]),
    );
    for (const t of list) {
      expect(t.title, t.name).not.toBe(t.name);
      expect(t.description.length, t.name).toBeGreaterThan(40);
      expect(t.stepKinds.length, t.name).toBeGreaterThan(0);
      expect(t.runsOffline, t.name).toBe(true);
      // A server path is not for the browser.
      expect(t.path).toBeUndefined();
    }
    const etl = list.find((t) => t.name === "market-etl")!;
    expect(etl.stepKinds).toEqual(
      expect.arrayContaining(["foreach", "tool", "validate", "branch"]),
    );
  });

  for (const template of listTemplates().map((t) => t.name)) {
    it(`saves ${template} into an empty folder, with its fixtures, and it replays with no key`, async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "");
      const res = await start().inject({
        method: "POST",
        url: "/api/spec/template",
        payload: { name: template },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().success).toBe(true);
      const source = readFileSync(specPath, "utf8");
      expect(parseSpec(source).errors).toEqual([]);
      // The schema pragma points at a real file from the new location, not at the repo's template folder.
      expect(source).not.toContain("../../../spec/schemas");
      const fixtures = join(dir, ".kampong", "fixtures");
      expect(readdirSync(fixtures).length).toBeGreaterThan(0);

      // Acceptance: the copy runs in replay on its own fixtures, no key and no terminal-side setup.
      const { io, out, err } = capture();
      const code = await runCli(
        ["run", specPath, "--input", "", "--json", "--tools", "replay"],
        io,
      );
      expect(code, out.join("\n") + err.join("\n")).toBe(EXIT_SUCCESS);
      expect((JSON.parse(out.join("\n")) as { status: string }).status).toBe("completed");
    });
  }

  it("refuses a template that is not there", async () => {
    const res = await start().inject({
      method: "POST",
      url: "/api/spec/template",
      payload: { name: "../../etc" },
    });
    expect(res.statusCode).toBe(404);
    expect(existsSync(specPath)).toBe(false);
  });

  it("does not replace a workflow that has content, unless asked to", async () => {
    writeFileSync(specPath, OTHER);
    const refused = await start().inject({
      method: "POST",
      url: "/api/spec/template",
      payload: { name: "market-etl" },
    });
    expect(refused.statusCode).toBe(409);
    expect(readFileSync(specPath, "utf8")).toBe(OTHER);

    const replaced = await app!.inject({
      method: "POST",
      url: "/api/spec/template",
      payload: { name: "market-etl", replace: true },
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(readFileSync(specPath, "utf8")).toContain("market");
  });
});
