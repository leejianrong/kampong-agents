import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { EXIT_SUCCESS, runCli } from "../../src/cli.js";
import { createDevServer } from "../../src/server.js";
import { capture } from "../unit/test-helpers.js";

// KAM-207 (ADR-0054): a spec imported through the canvas's endpoint and exported again is the same text, and the
// export runs under `kampong run --tools replay` and `kampong export` exactly like the original file. The
// template is market-etl, on its recorded fixtures: nothing here touches the network.

const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/market-etl/", import.meta.url));
const TEMPLATE = readFileSync(`${TEMPLATE_DIR}agent.yaml`, "utf8");
const FIXTURES = `${TEMPLATE_DIR}fixtures`;

const BLANK = `version: "1.0"
agent:
  id: blank
  name: "Blank"
  role: "Starting point"
  goal: "Be replaced."
  workflow:
    - step: first
      action: do_it
`;

describe("YAML import and export", () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kampong-yaml-"));
    writeFileSync(join(dir, "agent.yaml"), BLANK);
    app = createDevServer({
      specPath: join(dir, "agent.yaml"),
      layoutPath: join(dir, "layout.json"),
    });
    await app.ready();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("the offline test reached the network");
      }),
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (payload: object) => app.inject({ method: "PUT", url: "/api/spec/source", payload });

  it("imports the template byte for byte, and the downloaded text is the same file", async () => {
    const imported = await put({ source: TEMPLATE });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().success).toBe(true);
    expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(TEMPLATE);

    const exported = (await app.inject({ method: "GET", url: "/api/spec" })).json().source;
    expect(exported).toBe(TEMPLATE);
    // Importing the export changes nothing, and keeps the revision.
    const again = await put({ source: exported });
    expect(again.json().revision).toBe(imported.json().revision);
  });

  it("the exported text runs under `kampong run --tools replay` and exports to a project", async () => {
    await put({ source: TEMPLATE });
    const exportedPath = join(dir, "downloaded.yaml");
    writeFileSync(
      exportedPath,
      (await app.inject({ method: "GET", url: "/api/spec" })).json().source,
    );

    const run = async (specPath: string) => {
      const { io, out, err } = capture();
      const code = await runCli(
        [
          "run",
          specPath,
          "--input",
          "",
          "--json",
          "--tools",
          "replay",
          "--fixtures",
          FIXTURES,
          "--var",
          "symbols=AAPL,NVDA",
        ],
        io,
      );
      return { code, out: JSON.parse(out[0] ?? "{}"), err: err.join("\n") };
    };
    const original = await run(`${TEMPLATE_DIR}agent.yaml`);
    const downloaded = await run(exportedPath);
    expect(original.code, original.err).toBe(EXIT_SUCCESS);
    expect(downloaded.code, downloaded.err).toBe(EXIT_SUCCESS);
    expect(downloaded.out.status).toBe("completed");
    expect(downloaded.out.output).toEqual(original.out.output);

    const { io, err } = capture();
    const code = await runCli(["export", exportedPath, join(dir, "project")], io);
    expect(code, err.join("\n")).toBe(EXIT_SUCCESS);
  });

  it("an invalid import is a 422 with line numbers and the file is untouched", async () => {
    const bad = TEMPLATE.replace("version:", "version: [unclosed\nversion2:");
    const response = await put({ source: bad });
    expect(response.statusCode).toBe(422);
    expect(response.json().success).toBe(false);
    expect(response.json().errors[0].line).toBeGreaterThan(0);
    expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(BLANK);
  });

  it("answers 400 without a source, and 409 for a stale baseRevision", async () => {
    expect((await put({})).statusCode).toBe(400);
    const first = (await put({ source: BLANK })).json();
    await put({ source: TEMPLATE });
    const stale = await put({ source: BLANK, baseRevision: first.revision });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().errors[0].code).toBe("stale");
    expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(TEMPLATE);
  });
});
