import { createHmac, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { handleWebhookRequest, type ModelClient } from "@kampong/engine";
import { parseSpec } from "@kampong/spec";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createServer } from "../../../src/server.js";
import { workspaces } from "../../../src/db/schema.js";

// KAM-203 part C (ADR-0057): webhook trigger auth presets, `when` and `map` on the hosted ingress. The
// verification secret is generated per deployment and shown once; it is never read from the server's
// environment. The ingress runs the engine's own `handleWebhookRequest`, so a request is accepted or refused
// exactly as `kampong serve` would, which the parity test below checks against that function directly.
// Skips without DATABASE_URL.

const DATABASE_URL = process.env["DATABASE_URL"];

const model: ModelClient = {
  async generateText() {
    return "ok";
  },
  async generateStructured<T>() {
    return { result: {}, confidence: 1 } as T;
  },
};

const SPEC = `version: "1.1"
agent:
  id: gh-hook
  name: "GH"
  role: "r"
  goal: "g"
  trigger:
    type: webhook
    preset: github
    auth: { secret_env: GITHUB_SECRET }
    when: "trigger.action = 'opened'"
    map:
      repo: "trigger.repository.name"
  workflow:
    - step: pick
      type: transform
      set:
        repo: "trigger.repo"
`;

const BEARER_SPEC = `version: "1.1"
agent:
  id: am-hook
  name: "AM"
  role: "r"
  goal: "g"
  trigger:
    type: webhook
    preset: alertmanager
    auth: { secret_env: AM_TOKEN }
  workflow:
    - step: noop
      type: transform
      set:
        ok: "1"
`;

const sign = (secret: string, body: string) =>
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

describe.skipIf(!DATABASE_URL)("Hosted webhook auth, when and map (KAM-203 C)", () => {
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
    // The same name the spec's `secret_env` uses: it must NOT authenticate anything on hosted.
    process.env["GITHUB_SECRET"] = "server-env-value";
    process.env["BYOK_ROOT_KEY"] ??= Buffer.alloc(32, 7).toString("base64");
    app = createServer({ db, run: { createModel: () => model } });
    await app.ready();
  });

  afterAll(async () => {
    if (!DATABASE_URL) return;
    delete process.env["GITHUB_SECRET"];
    for (const id of createdWorkspaceIds) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    await app?.close();
    await pool?.end();
  });

  async function newUser(): Promise<{ cookie: string }> {
    const signUp = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: {
        email: `hook-${randomUUID()}@example.com`,
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

  async function deploy(cookie: string, source: string) {
    const created = await app.inject({
      method: "POST",
      url: "/api/specs",
      headers: { cookie },
      payload: { name: "hook", source },
    });
    expect(created.statusCode, created.body).toBe(201);
    const specId = created.json().id as string;
    const res = await app.inject({
      method: "PUT",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
    });
    return { specId, res, body: res.json() as Record<string, unknown> };
  }

  async function fire(path: string, body: string, headers: Record<string, string> = {}) {
    return app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });
  }

  async function finish(cookie: string, id: string) {
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: "GET", url: `/api/runs/${id}`, headers: { cookie } });
      const state = res.json().state;
      if (state.status !== "running") return state;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("run did not finish");
  }

  const OPENED = JSON.stringify({ action: "opened", repository: { name: "kampong" } });

  it("deploy issues the secret once; a redeploy and a read never show it again", async () => {
    const { cookie } = await newUser();
    const first = await deploy(cookie, SPEC);
    expect(first.res.statusCode).toBe(200);
    expect(first.body["webhookSecret"]).toMatch(/^whsec_/);
    const again = await app.inject({
      method: "PUT",
      url: `/api/specs/${first.specId}/deployment`,
      headers: { cookie },
    });
    expect(again.json().webhookSecret).toBeUndefined();
    const read = await app.inject({
      method: "GET",
      url: `/api/specs/${first.specId}/deployment`,
      headers: { cookie },
    });
    expect(JSON.stringify(read.json())).not.toContain(first.body["webhookSecret"] as string);
  });

  it("a validly signed request runs, with `map` fields as trigger.*", async () => {
    const { cookie } = await newUser();
    const { body } = await deploy(cookie, SPEC);
    const res = await fire(body["webhookPath"] as string, OPENED, {
      "x-hub-signature-256": sign(body["webhookSecret"] as string, OPENED),
    });
    expect(res.statusCode, res.body).toBe(201);
    const state = await finish(cookie, res.json().id);
    expect(state.status).toBe("completed");
    expect(state.finalOutput.pick).toEqual({ repo: "kampong" });
  });

  it("a missing, malformed or wrong signature is 401 and starts no run", async () => {
    const { cookie } = await newUser();
    const { body } = await deploy(cookie, SPEC);
    const path = body["webhookPath"] as string;
    const secret = body["webhookSecret"] as string;
    for (const headers of [
      {},
      { "x-hub-signature-256": "sha256=deadbeef" },
      { "x-hub-signature-256": sign("another-secret", OPENED) },
      { "x-hub-signature-256": sign(secret, OPENED + " ") },
    ]) {
      const res = await fire(path, OPENED, headers);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ success: false, error: "Unauthorized" });
    }
  });

  it("the server's own environment never authenticates a request, even under the spec's secret_env name", async () => {
    const { cookie } = await newUser();
    const { body } = await deploy(cookie, SPEC);
    const res = await fire(body["webhookPath"] as string, OPENED, {
      "x-hub-signature-256": sign("server-env-value", OPENED),
    });
    expect(res.statusCode).toBe(401);
  });

  it("`when` false: accepted, ignored, no run; unauthenticated callers learn nothing from it", async () => {
    const { cookie } = await newUser();
    const { body } = await deploy(cookie, SPEC);
    const path = body["webhookPath"] as string;
    const closed = JSON.stringify({ action: "closed", repository: { name: "kampong" } });
    const ok = await fire(path, closed, {
      "x-hub-signature-256": sign(body["webhookSecret"] as string, closed),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ success: true, ignored: true });
    const unsigned = await fire(path, closed);
    expect(unsigned.statusCode).toBe(401);
  });

  it("another workspace's secret, or its deployment, does not open this one (cross-tenant)", async () => {
    const a = await newUser();
    const b = await newUser();
    const da = await deploy(a.cookie, SPEC);
    const db2 = await deploy(b.cookie, SPEC);
    const secretA = da.body["webhookSecret"] as string;
    const secretB = db2.body["webhookSecret"] as string;
    expect(secretA).not.toBe(secretB);
    // A's secret on B's deployment, and B's on A's: both refused.
    expect(
      (
        await fire(db2.body["webhookPath"] as string, OPENED, {
          "x-hub-signature-256": sign(secretA, OPENED),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await fire(da.body["webhookPath"] as string, OPENED, {
          "x-hub-signature-256": sign(secretB, OPENED),
        })
      ).statusCode,
    ).toBe(401);
    // B's deployment id under A's workspace id is just unknown.
    const crossPath = `/hooks/w/${(da.body["webhookPath"] as string).split("/")[3]}/${(db2.body["webhookPath"] as string).split("/")[4]}`;
    expect(
      (await fire(crossPath, OPENED, { "x-hub-signature-256": sign(secretB, OPENED) })).statusCode,
    ).toBe(404);
    // B cannot rotate A's secret through A's spec id.
    const rotate = await app.inject({
      method: "POST",
      url: `/api/specs/${da.specId}/deployment/webhook-secret`,
      headers: { cookie: b.cookie },
    });
    expect(rotate.statusCode).toBe(404);
    // And it still works for A.
    expect(
      (
        await fire(da.body["webhookPath"] as string, OPENED, {
          "x-hub-signature-256": sign(secretA, OPENED),
        })
      ).statusCode,
    ).toBe(201);
  });

  it("rotating the secret retires the old one at once", async () => {
    const { cookie } = await newUser();
    const { specId, body } = await deploy(cookie, SPEC);
    const path = body["webhookPath"] as string;
    const rotated = await app.inject({
      method: "POST",
      url: `/api/specs/${specId}/deployment/webhook-secret`,
      headers: { cookie },
    });
    expect(rotated.statusCode).toBe(200);
    const fresh = rotated.json().webhookSecret as string;
    expect(
      (
        await fire(path, OPENED, {
          "x-hub-signature-256": sign(body["webhookSecret"] as string, OPENED),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await fire(path, OPENED, { "x-hub-signature-256": sign(fresh, OPENED) })).statusCode,
    ).toBe(201);
  });

  it("rotating on a spec whose trigger has no auth is a 422", async () => {
    const { cookie } = await newUser();
    const { specId } = await deploy(
      cookie,
      SPEC.replace(/\x20\x20trigger:[\s\S]*?\x20\x20workflow:/, "  workflow:"),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/specs/${specId}/deployment/webhook-secret`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(422);
  });

  it("a bearer preset (alertmanager) accepts its token and refuses others", async () => {
    const { cookie } = await newUser();
    const { body } = await deploy(cookie, BEARER_SPEC);
    const path = body["webhookPath"] as string;
    const token = body["webhookSecret"] as string;
    expect((await fire(path, "{}", { authorization: `Bearer ${token}` })).statusCode).toBe(201);
    expect((await fire(path, "{}", { authorization: "Bearer nope" })).statusCode).toBe(401);
    expect((await fire(path, "{}")).statusCode).toBe(401);
  });

  it("a trigger with no auth stays open and issues no secret, as before", async () => {
    const { cookie } = await newUser();
    const { body } = await deploy(
      cookie,
      BEARER_SPEC.replace("    preset: alertmanager\n    auth: { secret_env: AM_TOKEN }\n", ""),
    );
    expect(body["webhookSecret"]).toBeUndefined();
    expect((await fire(body["webhookPath"] as string, "{}")).statusCode).toBe(201);
  });

  it("refuses to deploy `respond: sync`, which the hosted ingress cannot hold a request for", async () => {
    const { cookie } = await newUser();
    const { res } = await deploy(
      cookie,
      BEARER_SPEC.replace(
        "    preset: alertmanager",
        "    respond: sync\n    preset: alertmanager",
      ),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/respond: sync/);
  });

  it("parity: hosted answers each request as `kampong serve`'s handler does for the same spec and secret", async () => {
    const { cookie } = await newUser();
    const { body } = await deploy(cookie, SPEC);
    const secret = body["webhookSecret"] as string;
    const trigger = parseSpec(SPEC).spec!.agent.trigger as never;
    const closed = JSON.stringify({ action: "closed", repository: { name: "kampong" } });
    const cases: [string, string, Record<string, string>][] = [
      ["signed, opened", OPENED, { "x-hub-signature-256": sign(secret, OPENED) }],
      ["signed, closed", closed, { "x-hub-signature-256": sign(secret, closed) }],
      ["bad signature", OPENED, { "x-hub-signature-256": sign("x", OPENED) }],
      ["no signature", OPENED, {}],
    ];
    for (const [name, payload, headers] of cases) {
      const local = await handleWebhookRequest(
        trigger,
        { headers, rawBody: payload },
        { env: { GITHUB_SECRET: secret } },
      );
      const hosted = await fire(body["webhookPath"] as string, payload, headers);
      const expected = { run: 201, ignore: 200, reject: 401, error: 422, respond: 200 }[
        local.action
      ];
      expect(hosted.statusCode, name).toBe(expected);
    }
  });
});
