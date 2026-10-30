import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDevServer } from "../../src/server.js";

const VALID_SOURCE = `# Greeter agent
version: "1.0"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  workflow:
    - step: greet
      action: say_hello
`;

describe("createDevServer", () => {
  let dir: string;
  let specPath: string;
  let layoutPath: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kampong-server-"));
    specPath = join(dir, "agent.yaml");
    layoutPath = join(dir, "layout.json");
    writeFileSync(specPath, VALID_SOURCE);
    app = createDevServer({ specPath, layoutPath });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET /api/spec parses the spec on disk with zero import step", async () => {
    const response = await app.inject({ method: "GET", url: "/api/spec" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.spec.agent.id).toBe("greeter");
    expect(body.layout["agent:greeter"]).toBeDefined();
    // KAM-183: the load carries the revision a write would, so Undo's stale guard has one from the start.
    const write = await app.inject({ method: "PUT", url: "/api/spec", payload: { ops: [] } });
    expect(body.revision).toBe(write.json().revision);
  });

  // KAM-186 (ADR-0061): a dragged node is pinned in layout.json and kept across a reload.
  it("PUT /api/layout pins a dragged node in the sidecar and GET /api/spec keeps it", async () => {
    await app.inject({ method: "GET", url: "/api/spec" });
    const response = await app.inject({
      method: "PUT",
      url: "/api/layout",
      payload: { positions: { "workflow:greet": { x: 640, y: 222 } } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().layout["workflow:greet"]).toEqual({ x: 640, y: 222, pinned: true });

    const onDisk = JSON.parse(readFileSync(layoutPath, "utf8"));
    expect(onDisk["workflow:greet"]).toEqual({ x: 640, y: 222, pinned: true });
    expect(onDisk["$layout"]).toBeDefined();

    const reload = (await app.inject({ method: "GET", url: "/api/spec" })).json();
    expect(reload.layout["workflow:greet"]).toEqual({ x: 640, y: 222, pinned: true });
    expect(reload.layout["agent:greeter"].pinned).toBeUndefined();
  });

  it("PUT /api/layout rejects a body without positions with a 400 and writes nothing", async () => {
    await app.inject({ method: "GET", url: "/api/spec" });
    const before = readFileSync(layoutPath, "utf8");
    const response = await app.inject({ method: "PUT", url: "/api/layout", payload: {} });
    expect(response.statusCode).toBe(400);
    expect(readFileSync(layoutPath, "utf8")).toBe(before);
  });

  it("PUT /api/spec applies a valid patch and persists it, preserving comments", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/spec",
      payload: { ops: [{ op: "set", path: ["agent", "goal"], value: "Say hi warmly" }] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);

    const onDisk = readFileSync(specPath, "utf8");
    expect(onDisk).toContain("Say hi warmly");
    expect(onDisk).toContain("# Greeter agent");
  });

  it("PUT /api/spec rejects an invalid patch with a 422 and leaves the file untouched", async () => {
    const before = readFileSync(specPath, "utf8");
    const response = await app.inject({
      method: "PUT",
      url: "/api/spec",
      payload: { ops: [{ op: "set", path: ["agent", "workflow", 0, "step"], value: "" }] },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().success).toBe(false);
    expect(readFileSync(specPath, "utf8")).toBe(before);
  });

  // KAM-170 (ADR-0055): the same endpoint takes step and tool operations and an optional baseRevision.
  describe("PUT /api/spec with step operations", () => {
    const put = (payload: unknown) =>
      app.inject({ method: "PUT", url: "/api/spec", payload: payload as object });

    it("renames a step: 200 with the revision and the changes, the file and the layout updated", async () => {
      await app.inject({ method: "GET", url: "/api/spec" }); // seeds the layout
      const response = await put({ ops: [{ op: "step.rename", step: "greet", to: "hello" }] });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.revision).toMatch(/^[0-9a-f]{16}$/);
      expect(body.changes.renamed).toEqual([{ kind: "step", from: "greet", to: "hello" }]);
      expect(readFileSync(specPath, "utf8")).toBe(
        VALID_SOURCE.replace("step: greet", "step: hello"),
      );
      const layout = JSON.parse(readFileSync(layoutPath, "utf8"));
      expect(layout["workflow:hello"]).toBeDefined();
      expect(layout["workflow:greet"]).toBeUndefined();
    });

    it("refuses a delete that would leave a read dangling: 422 with a code and the references", async () => {
      writeFileSync(
        specPath,
        VALID_SOURCE.replace(
          "      action: say_hello\n",
          '      action: say_hello\n    - step: again\n      action: "{{ greet.text }} again"\n',
        ).replace('version: "1.0"', 'version: "1.1"'),
      );
      const before = readFileSync(specPath, "utf8");
      const response = await put({ ops: [{ op: "step.remove", step: "greet" }] });

      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.success).toBe(false);
      expect(body.errors[0].code).toBe("has_references");
      expect(body.errors[0].references[0]).toMatchObject({ kind: "template", line: 12 });
      expect(readFileSync(specPath, "utf8")).toBe(before);
    });

    it("answers 409 with the current revision when baseRevision is stale, and writes nothing", async () => {
      const first = (await put({ ops: [] })).json();
      await put({ ops: [{ op: "set", path: ["agent", "goal"], value: "Changed" }] });
      const after = readFileSync(specPath, "utf8");

      const stale = await put({
        ops: [{ op: "set", path: ["agent", "goal"], value: "Lost" }],
        baseRevision: first.revision,
      });

      expect(stale.statusCode).toBe(409);
      expect(stale.json().errors[0].code).toBe("stale");
      expect(stale.json().revision).not.toBe(first.revision);
      expect(readFileSync(specPath, "utf8")).toBe(after);
    });
  });

  // KAN-1216: deleting the spec file out from under a running `kampong dev`
  // used to make GET /api/spec throw an uncaught ENOENT, which Fastify's
  // default error handler turned into a bare 500 leaking the raw fs error
  // (including the absolute server path) straight into the response body.
  describe("when the spec file has been deleted out from under a running server", () => {
    beforeEach(() => {
      unlinkSync(specPath);
    });

    // KAM-196: a missing spec is a new workflow, not an error.
    it("GET /api/spec answers 200 with missing: true instead of an error", async () => {
      const response = await app.inject({ method: "GET", url: "/api/spec" });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.missing).toBe(true);
      expect(body.success).toBe(false);
      expect(body.errors).toEqual([]);
      expect(body.source).toBe("");
      expect(JSON.stringify(body)).not.toContain(dir);
    });

    it("POST /api/spec/blank creates the file: valid, with the schema pragma, and loads afterwards", async () => {
      const response = await app.inject({ method: "POST", url: "/api/spec/blank" });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      const onDisk = readFileSync(specPath, "utf8");
      expect(onDisk.split("\n")[0]).toMatch(
        /^# yaml-language-server: \$schema=\S+agent-spec\.v1\.0\.schema\.json$/,
      );
      const loaded = (await app.inject({ method: "GET", url: "/api/spec" })).json();
      expect(loaded.success).toBe(true);
      expect(loaded.missing).toBeUndefined();
    });

    it("PUT /api/spec returns a clean 404 instead of a raw ENOENT 500 and does not mask it in a finally block", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/spec",
        payload: { ops: [{ op: "set", path: ["agent", "goal"], value: "Say hi warmly" }] },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.success).toBe(false);
      expect(typeof body.error).toBe("string");
      expect(body.error).not.toContain("ENOENT");
      expect(body.error).not.toContain(dir);
      expect(body.error).not.toContain(specPath);
    });
  });
  describe("starting a new workflow (KAM-196)", () => {
    it("POST /api/spec/blank refuses to overwrite a spec that has content", async () => {
      const response = await app.inject({ method: "POST", url: "/api/spec/blank" });

      expect(response.statusCode).toBe(409);
      expect(response.json().success).toBe(false);
      expect(readFileSync(specPath, "utf8")).toBe(VALID_SOURCE);
    });

    it("POST /api/spec/blank fills a file that exists but is empty", async () => {
      writeFileSync(specPath, "\n");
      const response = await app.inject({ method: "POST", url: "/api/spec/blank" });

      expect(response.statusCode).toBe(200);
      expect(readFileSync(specPath, "utf8")).toContain('version: "1.0"');
    });

    it("PUT /api/spec/source creates a missing file (a template choice or an import into a new folder)", async () => {
      unlinkSync(specPath);
      const response = await app.inject({
        method: "PUT",
        url: "/api/spec/source",
        payload: { source: VALID_SOURCE },
      });

      expect(response.statusCode).toBe(200);
      expect(readFileSync(specPath, "utf8")).toBe(VALID_SOURCE);
    });

    it("a file that exists but cannot be read is still a real error", async () => {
      unlinkSync(specPath);
      mkdirSync(specPath); // a directory where the file should be: EISDIR
      const response = await app.inject({ method: "GET", url: "/api/spec" });

      expect(response.statusCode).toBe(500);
      expect(response.json().success).toBe(false);
      expect(response.json().missing).toBeUndefined();
    });
  });
});
