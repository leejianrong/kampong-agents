import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../../src/server.js";
import type { Pool } from "pg";
import { createDbClient, type DbClient } from "../../src/db/client.js";

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

describe("createServer -- Better Auth mounting (KAN-1226)", () => {
  // No live Postgres needed here (matches test/unit/db/client.test.ts's own
  // "constructing a Pool never opens a network connection" property, plus
  // Better Auth's own Drizzle-adapter schema check, which "inspect[s] local
  // schema metadata without opening a connection" per its own docs --
  // verified empirically while building this card). The real, DB-backed
  // sign-up/sign-in/organization-create behavior is covered at the
  // integration layer (test/integration/db/auth.test.ts) -- this suite only
  // proves createServer's own "omit db to skip mounting entirely" contract
  // and that the routes exist and are reachable at all once db is given.

  let app: FastifyInstance | undefined;
  let pool: Pool | undefined;
  let previousSecret: string | undefined;

  function dbForThisTest(): DbClient {
    const result = createDbClient("postgres://user:pass@127.0.0.1:1/kampong");
    pool = result.pool;
    return result.db;
  }

  beforeEach(() => {
    previousSecret = process.env["BETTER_AUTH_SECRET"];
    process.env["BETTER_AUTH_SECRET"] = "unit-test-secret-not-for-prod";
  });

  afterEach(async () => {
    await app?.close();
    await pool?.end();
    app = undefined;
    pool = undefined;
    if (previousSecret === undefined) delete process.env["BETTER_AUTH_SECRET"];
    else process.env["BETTER_AUTH_SECRET"] = previousSecret;
  });

  it("does not mount /api/auth/* when no db is given (existing scaffold behavior, unaffected)", async () => {
    app = createServer();
    const response = await app.inject({ method: "GET", url: "/api/auth/ok" });
    expect(response.statusCode).toBe(404);
  });

  it("mounts /api/auth/* and reaches Better Auth's own handler when a db is given", async () => {
    app = createServer({ db: dbForThisTest() });
    await app.ready();

    // Better Auth's own liveness endpoint -- reaching it at all (regardless
    // of status code) proves the route is mounted and the request
    // successfully round-tripped through auth.handler(), not a 404 from
    // Fastify's own router.
    const response = await app.inject({ method: "GET", url: "/api/auth/ok" });
    expect(response.statusCode).not.toBe(404);
  });

  it("still serves /healthz unaffected by auth mounting", async () => {
    app = createServer({ db: dbForThisTest() });
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
  });

  // KAN-1227: the spec-CRUD routes follow the same "only mounted when a db is
  // given" shape as Better Auth's own routes above. Their real, DB-backed
  // behavior (CRUD, RLS isolation, the membership gate) is covered at the
  // integration layer (test/integration/routes/specs.test.ts); here we only
  // prove the mounting contract and that the auth gate runs before any DB
  // query (an anonymous request short-circuits to 401 without touching the
  // unreachable pool this suite constructs).
  it("does not mount /api/specs when no db is given", async () => {
    app = createServer();
    const response = await app.inject({ method: "GET", url: "/api/specs" });
    expect(response.statusCode).toBe(404);
  });

  it("mounts /api/specs when a db is given, and rejects an anonymous request with 401 (not 404)", async () => {
    app = createServer({ db: dbForThisTest() });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/specs" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ success: false });
  });

  // KAN-1229: the BYOK routes follow the same "only mounted with a db, auth
  // gate runs before any DB query" shape as the spec routes.
  it("does not mount /api/byok when no db is given", async () => {
    app = createServer();
    const response = await app.inject({ method: "GET", url: "/api/byok" });
    expect(response.statusCode).toBe(404);
  });

  it("mounts /api/byok when a db is given, and rejects an anonymous request with 401 (not 404)", async () => {
    app = createServer({ db: dbForThisTest() });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/byok" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ success: false });
  });
});
