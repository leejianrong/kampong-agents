import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../../src/server.js";
import { checkReadiness } from "../../src/readiness.js";

// KAM-330: /readyz asks the database, /healthz does not.

describe("checkReadiness", () => {
  it("is ok with no database configured (a server without one has nothing to ask)", async () => {
    expect(await checkReadiness(undefined)).toEqual({ ok: true, database: "none" });
  });

  it("is ok when the database answers", async () => {
    expect(await checkReadiness({ execute: async () => ({}) } as never)).toEqual({
      ok: true,
      database: "ok",
    });
  });

  it("is down when the database refuses", async () => {
    const db = {
      execute: async () => {
        throw new Error("connection refused");
      },
    };
    expect(await checkReadiness(db as never)).toEqual({ ok: false, database: "down" });
  });

  it("is down when the database does not answer in time, instead of hanging the probe", async () => {
    const db = { execute: () => new Promise(() => {}) };
    const started = Date.now();
    expect(await checkReadiness(db as never, 50)).toEqual({ ok: false, database: "down" });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("GET /readyz", () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it("answers 200 and says there is no database when none is configured", async () => {
    app = createServer();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", database: "none" });
  });
});
