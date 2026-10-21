import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  createAgentRun,
  createComponentDispatcher,
  createFirstPartyRegistry,
  InProcessModuleRunner,
  type ModelClient,
  type RunState,
} from "@kampong/engine";
import { parseSpec } from "@kampong/spec";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createServer } from "../../../src/server.js";
import { workspaces } from "../../../src/db/schema.js";
// @ts-expect-error plain .mjs fakes shared with the e2e suite; no type declarations
import { fakeFetch, requests } from "../../../../../e2e/fixtures/market-etl-network.mjs";
// @ts-expect-error plain .mjs fake model shared with the e2e suite; no type declarations
import { fakeModel } from "../../../../../e2e/fixtures/market-etl-model.mjs";

// KAM-203 (ADR-0027, ADR-0056): the hosted server runs version 1.1 specs with the same result as the local
// engine. Each case runs the market-etl template twice against the same offline fakes: once in-process with
// the engine (what `kampong run` does) and once through the hosted routes, then compares the outcome (status,
// final output, step trace) and every request made. Skips without DATABASE_URL.

const DATABASE_URL = process.env["DATABASE_URL"];

const SECRETS = {
  ALPHAVANTAGE_API_KEY: "parity-alpha-vantage-key",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_KEY: "parity-supabase-key",
  SLACK_BOT_TOKEN: "xoxb-parity-slack-token",
};

const TEMPLATE = readFileSync(
  fileURLToPath(new URL("../../../../cli/templates/market-etl/agent.yaml", import.meta.url)),
  "utf8",
);

interface Seen {
  service: string;
  method: string;
  url: string;
  body?: string;
}
const log = (): Seen[] =>
  (requests as Seen[]).map(({ service, method, url, body }) => ({ service, method, url, body }));

const outcome = (state: RunState) => ({
  status: state.status,
  output: state.finalOutput,
  skipped: state.skipped,
  error: state.error,
  trace: state.trace,
});

describe.skipIf(!DATABASE_URL)(
  "Hosted server runs spec 1.1 like the local engine (KAM-203)",
  () => {
    let db: DbClient;
    let pool: Pool;
    let app: FastifyInstance;
    const createdWorkspaceIds: string[] = [];

    beforeAll(async () => {
      if (!DATABASE_URL) return;
      await runMigrations(DATABASE_URL);
      ({ db, pool } = createDbClient(DATABASE_URL));
      process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-not-for-prod-0123456789";
      process.env["BETTER_AUTH_URL"] = "http://localhost:3000";
      delete process.env["GITHUB_CLIENT_ID"];
      delete process.env["GITHUB_CLIENT_SECRET"];
      app = createServer({
        db,
        run: {
          createModel: () => fakeModel as ModelClient,
          fetchImpl: fakeFetch,
          env: SECRETS,
        },
      });
      await app.ready();
    });

    afterAll(async () => {
      if (!DATABASE_URL) return;
      for (const id of createdWorkspaceIds) {
        await db.delete(workspaces).where(eq(workspaces.id, id));
      }
      await app?.close();
      await pool?.end();
    });

    async function newUserWithWorkspace(): Promise<{ cookie: string }> {
      const signUp = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        payload: {
          email: `parity-${randomUUID()}@example.com`,
          password: "correct-horse-battery-staple",
          name: "T",
        },
      });
      const setCookie = signUp.headers["set-cookie"];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
      const create = await app.inject({
        method: "POST",
        url: "/api/auth/organization/create",
        headers: { cookie, origin: "http://localhost:3000" },
        payload: { name: "WS", slug: `ws-${randomUUID()}` },
      });
      createdWorkspaceIds.push(create.json().id);
      return { cookie };
    }

    async function hostedRun(
      cookie: string,
      source: string,
      vars?: Record<string, unknown>,
    ): Promise<RunState> {
      const created = await app.inject({
        method: "POST",
        url: "/api/specs",
        headers: { cookie },
        payload: { name: "parity", source },
      });
      expect(created.statusCode).toBe(201);
      const start = await app.inject({
        method: "POST",
        url: `/api/specs/${created.json().id}/runs`,
        headers: { cookie },
        payload: { input: "", ...(vars ? { vars } : {}) },
      });
      expect(start.statusCode, start.body).toBe(201);
      const runId = start.json().id;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const res = await app.inject({
          method: "GET",
          url: `/api/runs/${runId}`,
          headers: { cookie },
        });
        const state = res.json().state as RunState;
        if (state.status !== "running") return state;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("run did not finish in time");
    }

    async function localRun(source: string, vars?: Record<string, unknown>): Promise<RunState> {
      const parsed = parseSpec(source);
      expect(parsed.success, JSON.stringify(parsed.errors)).toBe(true);
      const registry = createFirstPartyRegistry();
      return createAgentRun(parsed.spec!, {
        env: SECRETS,
        fetchImpl: fakeFetch,
        model: fakeModel as ModelClient,
        components: createComponentDispatcher({
          registry,
          runner: new InProcessModuleRunner(registry),
        }),
        ...(vars ? { vars } : {}),
      }).start("");
    }

    const cases: { name: string; vars?: Record<string, unknown>; alerts: number }[] = [
      {
        name: "default threshold: AAPL alerts, NVDA does not, MSFT is rate-limited",
        vars: { symbols: ["AAPL", "MSFT", "NVDA"] },
        alerts: 1,
      },
      {
        name: "a threshold nothing reaches: rows are written and nothing is posted",
        vars: { symbols: ["AAPL", "NVDA"], threshold: 50 },
        alerts: 0,
      },
    ];

    for (const c of cases) {
      it(`market-etl, ${c.name}: same result, same requests`, async () => {
        const { cookie } = await newUserWithWorkspace();

        requests.length = 0;
        const local = await localRun(TEMPLATE, c.vars);
        const localLog = log();
        expect(local.status, local.error).toBe("completed");

        requests.length = 0;
        const hosted = await hostedRun(cookie, TEMPLATE, c.vars);
        const hostedLog = log();

        expect(outcome(hosted)).toEqual(JSON.parse(JSON.stringify(outcome(local))));
        expect(hostedLog).toEqual(localLog);
        expect(hostedLog.filter((r) => r.service === "slack")).toHaveLength(c.alerts);
      }, 30_000);
    }

    it("a var override the engine rejects fails the hosted run visibly, as it does locally", async () => {
      const { cookie } = await newUserWithWorkspace();
      const hosted = await hostedRun(cookie, TEMPLATE, { threshold: "not a number" });
      expect(hosted.status).toBe("failed");
      expect(hosted.error).toMatch(/vars\.threshold/);
    });

    it("rejects a `vars` that is not an object with 400", async () => {
      const { cookie } = await newUserWithWorkspace();
      const created = await app.inject({
        method: "POST",
        url: "/api/specs",
        headers: { cookie },
        payload: { name: "parity", source: TEMPLATE },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/specs/${created.json().id}/runs`,
        headers: { cookie },
        payload: { input: "", vars: ["symbols"] },
      });
      expect(res.statusCode).toBe(400);
    });
  },
);

// A tenant's spec must not be able to read the server's own environment (database URL, BYOK root key).
describe.skipIf(!DATABASE_URL)(
  "Hosted runs do not expose the server's environment (KAM-203)",
  () => {
    let db: DbClient;
    let pool: Pool;
    let app: FastifyInstance;
    const createdWorkspaceIds: string[] = [];

    beforeAll(async () => {
      if (!DATABASE_URL) return;
      await runMigrations(DATABASE_URL);
      ({ db, pool } = createDbClient(DATABASE_URL));
      process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-not-for-prod-0123456789";
      process.env["BETTER_AUTH_URL"] = "http://localhost:3000";
      process.env["KAM203_SERVER_ONLY_SECRET"] = "server-only-value";
      app = createServer({
        db,
        run: { createModel: () => fakeModel as ModelClient },
      });
      await app.ready();
    });

    afterAll(async () => {
      if (!DATABASE_URL) return;
      delete process.env["KAM203_SERVER_ONLY_SECRET"];
      for (const id of createdWorkspaceIds) {
        await db.delete(workspaces).where(eq(workspaces.id, id));
      }
      await app?.close();
      await pool?.end();
    });

    it("a var defaulting to ${SERVER_ENV} fails the run as unset instead of reading the server's value", async () => {
      const signUp = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        payload: {
          email: `env-${randomUUID()}@example.com`,
          password: "correct-horse-battery-staple",
          name: "T",
        },
      });
      const setCookie = signUp.headers["set-cookie"];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
      const org = await app.inject({
        method: "POST",
        url: "/api/auth/organization/create",
        headers: { cookie, origin: "http://localhost:3000" },
        payload: { name: "WS", slug: `ws-${randomUUID()}` },
      });
      createdWorkspaceIds.push(org.json().id);
      const source = `version: "1.1"
vars:
  leak:
    type: string
    default: "\${KAM203_SERVER_ONLY_SECRET}"
agent:
  id: leak
  name: "Leak"
  role: "r"
  goal: "g"
  workflow:
    - step: copy
      type: transform
      set:
        value: "vars.leak"
`;
      const created = await app.inject({
        method: "POST",
        url: "/api/specs",
        headers: { cookie },
        payload: { name: "leak", source },
      });
      expect(created.statusCode, created.body).toBe(201);
      const start = await app.inject({
        method: "POST",
        url: `/api/specs/${created.json().id}/runs`,
        headers: { cookie },
        payload: { input: "" },
      });
      const runId = start.json().id;
      let state: RunState | undefined;
      for (let i = 0; i < 200; i++) {
        const res = await app.inject({
          method: "GET",
          url: `/api/runs/${runId}`,
          headers: { cookie },
        });
        state = res.json().state as RunState;
        if (state.status !== "running") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(state?.status).toBe("failed");
      expect(state?.error).toMatch(/KAM203_SERVER_ONLY_SECRET is not set/);
      expect(JSON.stringify(state)).not.toContain("server-only-value");
    });
  },
);
