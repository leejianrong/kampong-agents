import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDevServer } from "../../src/server.js";

// SLICES.md V3 (KAN-1109): `kampong dev` serves the built canvas static
// assets AND the spec-CRUD API from one localhost origin (ADR-0005), not
// two separate processes/ports. This exercises `createDevServer`'s new
// `staticDir` option directly against a fixture "built canvas" directory
// (a real `apps/canvas/dist` isn't required to be built for this test).

const VALID_SOURCE = `version: "1.0"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  workflow:
    - step: greet
      action: say_hello
`;

describe("createDevServer -- static canvas asset serving (KAN-1109)", () => {
  let specDir: string;
  let staticDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    specDir = mkdtempSync(join(tmpdir(), "kampong-dev-spec-"));
    staticDir = mkdtempSync(join(tmpdir(), "kampong-dev-static-"));
    writeFileSync(join(specDir, "agent.yaml"), VALID_SOURCE);
    writeFileSync(
      join(staticDir, "index.html"),
      "<!doctype html><html><body>kampong canvas</body></html>",
    );
    mkdirSync(join(staticDir, "assets"));
    writeFileSync(join(staticDir, "assets", "app.js"), "console.log('canvas app');");

    app = createDevServer({
      specPath: join(specDir, "agent.yaml"),
      layoutPath: join(specDir, ".kampong", "layout.json"),
      staticDir,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(specDir, { recursive: true, force: true });
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

  it("still serves the spec-CRUD API from the same origin, not shadowed by the static handler", async () => {
    const response = await app.inject({ method: "GET", url: "/api/spec" });
    expect(response.statusCode).toBe(200);
    expect(response.json().spec.agent.id).toBe("greeter");
  });
});

describe("createDevServer -- no staticDir given", () => {
  it("still serves the API normally (staticDir is optional)", async () => {
    const specDir = mkdtempSync(join(tmpdir(), "kampong-dev-nostatic-"));
    writeFileSync(join(specDir, "agent.yaml"), VALID_SOURCE);
    const app = createDevServer({
      specPath: join(specDir, "agent.yaml"),
      layoutPath: join(specDir, ".kampong", "layout.json"),
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/spec" });
    expect(response.statusCode).toBe(200);

    await app.close();
    rmSync(specDir, { recursive: true, force: true });
  });
});
