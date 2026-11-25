import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { ModelClient } from "@kampong/engine";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createServer } from "../../../src/server.js";
import { workspaces } from "../../../src/db/schema.js";

// KAN-1436 (ADR-0022, ADR-0023): the managed "go live" lifecycle API (deploy/
// pause/redeploy) and the public webhook-ingress route, end to end through
// the server's inject() against a real Postgres. Mirrors runs.test.ts's own
// setup (fake ModelClient via the `run.createModel` seam, so a
// webhook-triggered run completes deterministically with no network and no
// stored BYOK key). Skips without DATABASE_URL; runs in CI against the
// non-superuser role (KAN-1388).

const DATABASE_URL = process.env["DATABASE_URL"];

function fakeModel(): ModelClient {
  return {
    async generateText() {
      return "hello";
    },
    async generateStructured<T>() {
      return { result: { greeted: true }, confidence: 0.99 } as T;
    },
  };
}

const GREETER_SPEC = `version: "1.0"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  trigger:
    type: webhook
  workflow:
    - step: greet
      action: say_hello
`;

describe.skipIf(!DATABASE_URL)("Deployment routes against a real Postgres", () => {
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
      run: { createModel: fakeModel },
      publicBaseUrl: "https://kampong.test",
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

  function uniqueEmail(): string {
    return `deployments-${randomUUID()}@example.com`;
  }

  async function newUserWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const signUp = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: uniqueEmail(), password: "correct-horse-battery-staple", name: "T" },
    });
    const setCookie = signUp.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
    const create = await app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      headers: { cookie, origin: "http://localhost:3000" },
      payload: { name: "WS", slug: `ws-${randomUUID()}` },
    });
    const workspaceId = create.json().id;
    createdWorkspaceIds.push(workspaceId);
    return { cookie, workspaceId };
  }

  async function createSpec(cookie: string): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/specs",
      headers: { cookie },
      payload: { name: "greeter", source: GREETER_SPEC },
    });
    return created.json().id;
  }

  async function waitForTerminal(cookie: string, id: string, timeoutMs = 4000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await app.inject({ method: "GET", url: `/api/runs/${id}`, headers: { cookie } });
      const status = res.json().state?.status;
      if (status && status !== "running") return res.json().state;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("run did not reach a terminal state in time");
  }

  it("rejects an unauthenticated deploy with 401", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/specs/${randomUUID()}/deployment`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 deploying a spec that isn't in the workspace", async () => {
    const { cookie } = await newUserWithWorkspace();
    const res = await app.inject({
      method: "PUT",
      url: `/api/specs/${randomUUID()}/deployment`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 reading a deployment that was never created", async () => {
    const { cookie } = await newUserWithWorkspace();
    const specId = await createSpec(cookie);
    const res = await app.inject({
      method: "GET",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("deploys a spec, drives a real run through the webhook, then pauses/redeploys/tears down", async () => {
    const { cookie, workspaceId } = await newUserWithWorkspace();
    const specId = await createSpec(cookie);

    // Deploy.
    const deploy = await app.inject({
      method: "PUT",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
    });
    expect(deploy.statusCode).toBe(200);
    const { deploymentId, status, webhookPath } = deploy.json();
    expect(status).toBe("live");
    expect(webhookPath).toBe(`/hooks/w/${workspaceId}/${deploymentId}`);
    // KAM-321: the full address is PUBLIC_BASE_URL plus the path, on deploy and on read.
    expect(deploy.json().webhookUrl).toBe(`https://kampong.test${webhookPath}`);

    // GET reflects it.
    const get = await app.inject({
      method: "GET",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().deploymentId).toBe(deploymentId);
    expect(get.json().webhookUrl).toBe(`https://kampong.test${webhookPath}`);

    // Redeploying (PUT again) is idempotent: same deployment id/URL.
    const redeploy = await app.inject({
      method: "PUT",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
    });
    expect(redeploy.json().deploymentId).toBe(deploymentId);

    // The webhook is unauthenticated -- no cookie -- and starts a real,
    // durable run via the same HostedRunManager the canvas-triggered
    // /api/specs/:id/runs route uses.
    const hook = await app.inject({
      method: "POST",
      url: webhookPath,
      payload: { hello: "world" },
    });
    expect(hook.statusCode).toBe(201);
    const runId = hook.json().id;
    const finalState = (await waitForTerminal(cookie, runId)) as { status: string };
    expect(finalState.status).toBe("completed");

    // Pause: the same webhook path now looks like it never existed.
    const pause = await app.inject({
      method: "PATCH",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
      payload: { status: "paused" },
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().status).toBe("paused");

    const hookWhilePaused = await app.inject({ method: "POST", url: webhookPath, payload: {} });
    expect(hookWhilePaused.statusCode).toBe(404);

    // Resume via PATCH -- the webhook works again, at the SAME URL.
    const resume = await app.inject({
      method: "PATCH",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
      payload: { status: "live" },
    });
    expect(resume.json().status).toBe("live");
    const hookAfterResume = await app.inject({ method: "POST", url: webhookPath, payload: {} });
    expect(hookAfterResume.statusCode).toBe(201);

    // Tear down entirely.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);
    const hookAfterDelete = await app.inject({ method: "POST", url: webhookPath, payload: {} });
    expect(hookAfterDelete.statusCode).toBe(404);
  });

  it("lists a spec's runs with how each started, and only to its own workspace (KAM-324)", async () => {
    const { cookie } = await newUserWithWorkspace();
    const specId = await createSpec(cookie);
    const deploy = await app.inject({
      method: "PUT",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie },
    });
    const { webhookPath } = deploy.json();
    const hook = await app.inject({ method: "POST", url: webhookPath, payload: {} });
    expect(hook.statusCode).toBe(201);
    const manual = await app.inject({
      method: "POST",
      url: `/api/specs/${specId}/runs`,
      headers: { cookie },
      payload: { input: "hello" },
    });
    expect(manual.statusCode).toBe(201);
    await waitForTerminal(cookie, hook.json().id);
    await waitForTerminal(cookie, manual.json().id);

    const list = await app.inject({
      method: "GET",
      url: `/api/specs/${specId}/runs?limit=10`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const listed = list.json().runs as Array<{
      id: string;
      source: string;
      triggeredBy: string;
      outcome: string;
    }>;
    expect(listed.map((r) => r.source).sort()).toEqual(["manual", "webhook"]);
    expect(listed.find((r) => r.source === "webhook")?.triggeredBy).toBe("webhook");
    expect(listed.find((r) => r.source === "manual")?.triggeredBy).toMatch(/\S/);
    expect(listed.every((r) => r.outcome === "Finished")).toBe(true);

    const approvals = await app.inject({
      method: "GET",
      url: `/api/specs/${specId}/approvals`,
      headers: { cookie },
    });
    expect(approvals.statusCode).toBe(200);
    expect(approvals.json().approvals).toEqual([]);

    // Another workspace cannot read this spec's runs or approvals.
    const other = await newUserWithWorkspace();
    for (const path of ["runs", "approvals"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/specs/${specId}/${path}`,
        headers: { cookie: other.cookie },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it("turns a flood and an oversize body away without saying which ids are real (KAM-322)", async () => {
    const limited = createServer({
      db,
      run: { createModel: fakeModel },
      // Capacity is a quarter of a minute's allowance: 4 a minute is a burst of 1.
      ingressLimits: { deploymentPerMinute: 4, ipPerMinute: 600, maxBodyBytes: 1024 },
    });
    await limited.ready();
    try {
      const ghost = `/hooks/w/${randomUUID()}/${randomUUID()}`;
      const first = await limited.inject({ method: "POST", url: ghost, payload: {} });
      expect(first.statusCode).toBe(404);
      const second = await limited.inject({ method: "POST", url: ghost, payload: {} });
      expect(second.statusCode).toBe(429);
      expect(Number(second.headers["retry-after"])).toBeGreaterThanOrEqual(1);

      const big = await limited.inject({
        method: "POST",
        url: `/hooks/w/${randomUUID()}/${randomUUID()}`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ pad: "x".repeat(4096) }),
      });
      expect(big.statusCode).toBe(413);
    } finally {
      await limited.close();
    }
  });

  it("returns 404 for a well-formed but unknown workspaceId/deploymentId webhook path", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/hooks/w/${randomUUID()}/${randomUUID()}`,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("isolates deployments per workspace: workspace B's webhook path with A's deploymentId under B's own workspaceId is 404", async () => {
    const a = await newUserWithWorkspace();
    const b = await newUserWithWorkspace();
    const specId = await createSpec(a.cookie);
    const deploy = await app.inject({
      method: "PUT",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie: a.cookie },
    });
    const { deploymentId } = deploy.json();

    // A's real deploymentId, but B's workspaceId in the path -- RLS scopes
    // the read to B's workspace, so the row (which belongs to A) isn't found.
    const crossed = await app.inject({
      method: "POST",
      url: `/hooks/w/${b.workspaceId}/${deploymentId}`,
      payload: {},
    });
    expect(crossed.statusCode).toBe(404);

    // B also can't see A's deployment through the authenticated GET.
    const crossedGet = await app.inject({
      method: "GET",
      url: `/api/specs/${specId}/deployment`,
      headers: { cookie: b.cookie },
    });
    expect(crossedGet.statusCode).toBe(404);
  });
});
