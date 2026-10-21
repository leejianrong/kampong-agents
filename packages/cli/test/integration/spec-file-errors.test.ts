import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDevServer, specFileErrorResponse } from "../../src/server.js";

// KAM-195: a save that fails is reported as a save failure, naming the cause, not as "Spec file could not be
// read". A read-only agent.yaml used to give that wrong sentence (and the canvas offered a Retry that reloads).

const SOURCE = `version: "1.0"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  workflow:
    - step: greet
      action: say_hello
`;

const errno = (code: string) =>
  Object.assign(new Error(`${code}: boom, open '/secret/place/agent.yaml'`), { code });

describe("specFileErrorResponse", () => {
  const path = "/work/project/agent.yaml";

  it.each([
    ["EACCES", /^Could not save: agent\.yaml is not writable \(permission denied\)\.$/],
    ["EPERM", /^Could not save: agent\.yaml is not writable \(permission denied\)\.$/],
    ["EROFS", /^Could not save: agent\.yaml is on a read-only file system\.$/],
    ["ENOSPC", /^Could not save: the disk is full\.$/],
    ["EDQUOT", /^Could not save: the disk quota is exceeded\.$/],
    ["EIO", /^Could not save: agent\.yaml could not be written\.$/],
  ])("a write that fails with %s names the cause as a save failure", (code, message) => {
    const { status, body } = specFileErrorResponse(errno(code), path, "write");
    expect(status).toBe(500);
    expect(body.error).toMatch(message);
    // Never the raw errno text or a host path.
    expect(body.error).not.toContain("/secret");
    expect(body.error).not.toContain(code);
  });

  it("keeps a read failure a read failure, with the cause when it is a permission", () => {
    expect(specFileErrorResponse(errno("EACCES"), path, "read").body.error).toBe(
      "Spec file could not be read: agent.yaml (permission denied).",
    );
    expect(specFileErrorResponse(errno("EIO"), path, "read").body.error).toBe(
      "Spec file could not be read: agent.yaml.",
    );
    expect(specFileErrorResponse(errno("EIO"), path).body.error).toBe(
      "Spec file could not be read: agent.yaml.",
    );
  });

  it("still says a missing file is missing, for a read or a write", () => {
    for (const op of ["read", "write"] as const) {
      const { status, body } = specFileErrorResponse(errno("ENOENT"), path, op);
      expect(status).toBe(404);
      expect(body.error).toContain("Spec file not found");
    }
  });
});

describe.skipIf(process.getuid?.() === 0)("a read-only agent.yaml on the dev server", () => {
  let dir: string;
  let specPath: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kampong-readonly-"));
    specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SOURCE);
    app = createDevServer({ specPath, layoutPath: join(dir, "layout.json") });
    await app.ready();
    chmodSync(specPath, 0o444);
  });

  afterEach(async () => {
    await app.close();
    chmodSync(specPath, 0o644);
    rmSync(dir, { recursive: true, force: true });
  });

  it("PUT /api/spec says it could not save, because the file is not writable, and leaves the file alone", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/spec",
      payload: { ops: [{ op: "set", path: ["agent", "goal"], value: "Say hi warmly" }] },
    });
    expect(response.statusCode).toBe(500);
    const error = response.json().error as string;
    expect(error).toBe("Could not save: agent.yaml is not writable (permission denied).");
    expect(error).not.toContain("could not be read");
    expect(readFileSync(specPath, "utf8")).toBe(SOURCE);
  });

  it("PUT /api/spec/source (import) says the same, and reading the file still works", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/spec/source",
      payload: { source: SOURCE.replace("Greet visitors.", "Greet everyone.") },
    });
    expect(put.statusCode).toBe(500);
    expect(put.json().error).toMatch(/^Could not save: agent\.yaml is not writable/);
    const get = await app.inject({ method: "GET", url: "/api/spec" });
    expect(get.statusCode).toBe(200);
    expect(get.json().success).toBe(true);
  });
});
