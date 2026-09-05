import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

  // KAN-1216: deleting the spec file out from under a running `kampong dev`
  // used to make GET /api/spec throw an uncaught ENOENT, which Fastify's
  // default error handler turned into a bare 500 leaking the raw fs error
  // (including the absolute server path) straight into the response body.
  describe("when the spec file has been deleted out from under a running server", () => {
    beforeEach(() => {
      unlinkSync(specPath);
    });

    it("GET /api/spec returns a clean 404 instead of a raw ENOENT 500", async () => {
      const response = await app.inject({ method: "GET", url: "/api/spec" });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.success).toBe(false);
      expect(typeof body.error).toBe("string");
      expect(body.error).not.toContain("ENOENT");
      expect(body.error).not.toContain(dir);
      expect(body.error).not.toContain(specPath);
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
});
