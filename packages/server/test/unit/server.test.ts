import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../../src/server.js";

// KAN-1221 (V5 build-plan step 1, ADR-0013): this is a foundational
// scaffold, not the hosted backend -- no DB, no auth yet (those are later
// cards). What's verifiable at this stage: the server boots without
// throwing (proving the @kampong/spec + @kampong/engine wiring resolves
// through this package's own dist/ build, per wiring-check.ts), and
// /healthz responds correctly, with or without the canvas static assets
// present.

describe("createServer -- boots without throwing", () => {
  it("constructs successfully with no staticDir (most of this suite)", () => {
    expect(() => createServer()).not.toThrow();
  });

  it("returns a real Fastify instance that can be brought to ready() and closed", async () => {
    const app = createServer();
    await app.ready();
    await app.close();
  });
});

describe("GET /healthz", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = createServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it('responds 200 with { status: "ok" }', async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  it("reports both startup wiring checks (@kampong/spec, @kampong/engine) as ok", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.json().checks).toEqual({ specValidator: "ok", modelClient: "ok" });
  });
});

describe("createServer -- static canvas asset serving", () => {
  let staticDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    staticDir = mkdtempSync(join(tmpdir(), "kampong-server-static-"));
    writeFileSync(
      join(staticDir, "index.html"),
      "<!doctype html><html><body>kampong canvas</body></html>",
    );
    mkdirSync(join(staticDir, "assets"));
    writeFileSync(join(staticDir, "assets", "app.js"), "console.log('canvas app');");

    app = createServer({ staticDir });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(staticDir, { recursive: true, force: true });
  });

  it("serves the canvas index.html at the root", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("kampong canvas");
  });

  it("serves nested static assets (e.g. bundled JS)", async () => {
    const response = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("canvas app");
  });

  it("still serves /healthz from the same origin, not shadowed by the static handler", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });
});
