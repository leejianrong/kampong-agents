import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { createServer } from "../../../src/server.js";
import { auditEvents, session, workspaceMembers, workspaces } from "../../../src/db/schema.js";
import { withWorkspaceScope } from "../../../src/db/workspace-scope.js";

// KAM-328: every route that needs a permission refuses a member whose role lacks it, with a 403 that names it.
// Skips without DATABASE_URL; runs in CI.

const DATABASE_URL = process.env["DATABASE_URL"];

type Route = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: object;
  permission: string;
};
const SOME = randomUUID();

const ROUTES: Route[] = [
  { method: "GET", url: "/api/specs", permission: "spec:read" },
  {
    method: "POST",
    url: "/api/specs",
    payload: { name: "x", source: "x" },
    permission: "spec:write",
  },
  { method: "GET", url: `/api/specs/${SOME}`, permission: "spec:read" },
  {
    method: "PUT",
    url: `/api/specs/${SOME}/layout`,
    payload: { positions: {} },
    permission: "spec:write",
  },
  { method: "PUT", url: `/api/specs/${SOME}`, payload: { ops: [] }, permission: "spec:write" },
  {
    method: "PUT",
    url: `/api/specs/${SOME}/source`,
    payload: { source: "x" },
    permission: "spec:write",
  },
  { method: "GET", url: `/api/specs/${SOME}/runs`, permission: "run:read" },
  { method: "GET", url: `/api/specs/${SOME}/approvals`, permission: "run:read" },
  {
    method: "POST",
    url: `/api/specs/${SOME}/runs`,
    payload: { input: "x" },
    permission: "run:start",
  },
  { method: "GET", url: `/api/runs/${SOME}`, permission: "run:read" },
  { method: "GET", url: `/api/runs/${SOME}/trace`, permission: "run:read" },
  {
    method: "POST",
    url: `/api/runs/${SOME}/approve`,
    payload: { approved: true },
    permission: "approval:resolve",
  },
  { method: "GET", url: `/api/specs/${SOME}/deployment`, permission: "deployment:read" },
  { method: "PUT", url: `/api/specs/${SOME}/deployment`, permission: "deployment:manage" },
  {
    method: "PATCH",
    url: `/api/specs/${SOME}/deployment`,
    payload: { status: "paused" },
    permission: "deployment:manage",
  },
  { method: "DELETE", url: `/api/specs/${SOME}/deployment`, permission: "deployment:manage" },
  {
    method: "POST",
    url: `/api/specs/${SOME}/deployment/webhook-secret`,
    permission: "deployment:manage",
  },
  { method: "GET", url: "/api/secrets", permission: "secret:read" },
  { method: "PUT", url: "/api/secrets/NAME", payload: { value: "v" }, permission: "secret:write" },
  { method: "DELETE", url: "/api/secrets/NAME", permission: "secret:write" },
  { method: "GET", url: "/api/usage", permission: "run:read" },
  { method: "GET", url: "/api/audit", permission: "audit:read" },
  { method: "GET", url: "/api/byok", permission: "byok:read" },
  {
    method: "PUT",
    url: "/api/byok/openai",
    payload: { key: "sk-test-1234" },
    permission: "byok:write",
  },
  { method: "DELETE", url: "/api/byok/openai", permission: "byok:write" },
];

const ALLOWED: Record<string, string[]> = {
  admin: ROUTES.map((r) => r.permission),
  editor: [
    "spec:read",
    "spec:write",
    "run:read",
    "run:start",
    "approval:resolve",
    "deployment:read",
    "deployment:manage",
    "secret:read",
  ],
  approver: ["spec:read", "run:read", "approval:resolve", "deployment:read"],
  viewer: ["spec:read", "run:read", "deployment:read"],
};

describe.skipIf(!DATABASE_URL)("Workspace roles on every route (KAM-328)", () => {
  let db: DbClient;
  let pool: Pool;
  let app: FastifyInstance;
  let workspaceId: string;
  const created: string[] = [];
  const cookies: Record<string, string> = {};

  async function signUp(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: {
        email: `roles-${randomUUID()}@example.com`,
        password: "correct-horse-battery-staple",
        name: "T",
      },
    });
    const sc = res.headers["set-cookie"];
    return (Array.isArray(sc) ? sc[0] : sc)!.split(";")[0]!;
  }

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await runMigrations(DATABASE_URL);
    ({ db, pool } = createDbClient(DATABASE_URL));
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-not-for-prod-0123456789";
    process.env["BETTER_AUTH_URL"] = "http://localhost:3000";
    process.env["BYOK_ROOT_KEY"] ??= Buffer.alloc(32, 7).toString("base64");
    app = createServer({ db });

    cookies["admin"] = await signUp();
    const create = await app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      headers: { cookie: cookies["admin"], origin: "http://localhost:3000" },
      payload: { name: "WS", slug: `ws-${randomUUID()}` },
    });
    workspaceId = create.json().id;
    created.push(workspaceId);

    for (const role of ["editor", "approver", "viewer"]) {
      const cookie = await signUp();
      const me = await app.inject({
        method: "GET",
        url: "/api/auth/get-session",
        headers: { cookie },
      });
      const userId = me.json().user.id as string;
      await withWorkspaceScope(db, workspaceId, (tx) =>
        tx.insert(workspaceMembers).values({ workspaceId, userId, role }),
      );
      // Better Auth's own set-active cannot see the membership row under RLS, so point the session at the
      // workspace directly: this test is about what the routes do with the role, not about session setup.
      await db
        .update(session)
        .set({ activeOrganizationId: workspaceId })
        .where(eq(session.userId, userId));
      cookies[role] = cookie;
    }
  });

  afterAll(async () => {
    if (!DATABASE_URL) return;
    for (const id of created) await db.delete(workspaces).where(eq(workspaces.id, id));
    await app?.close();
    await pool?.end();
  });

  for (const role of ["admin", "editor", "approver", "viewer"]) {
    it(`${role}: 403 naming the permission when the role lacks it, and not 403 when it has it`, async () => {
      for (const route of ROUTES) {
        const res = await app.inject({
          method: route.method,
          url: route.url,
          headers: { cookie: cookies[role]!, origin: "http://localhost:3000" },
          ...(route.payload ? { payload: route.payload } : {}),
        });
        const label = `${role} ${route.method} ${route.url}`;
        if (ALLOWED[role]!.includes(route.permission)) {
          expect(res.statusCode, label).not.toBe(403);
        } else {
          expect(res.statusCode, label).toBe(403);
          expect(res.json().permission, label).toBe(route.permission);
        }
      }
    });
  }

  it("a viewer gets 403 on every mutating route", () => {
    const mutating = ROUTES.filter((r) => r.method !== "GET");
    expect(mutating.length).toBeGreaterThan(10);
    for (const r of mutating) expect(ALLOWED["viewer"]).not.toContain(r.permission);
  });

  describe("audit log (KAM-66)", () => {
    const get = (role: string, url: string) =>
      app.inject({
        method: "GET",
        url,
        headers: { cookie: cookies[role]!, origin: "http://localhost:3000" },
      });

    it("records an allowed change without its value, and a refused one as a deny", async () => {
      const name = `AUDIT_${randomUUID().slice(0, 8).toUpperCase()}`;
      const value = "super-secret-value-xyz";
      const ok = await app.inject({
        method: "PUT",
        url: `/api/secrets/${name}`,
        headers: { cookie: cookies["admin"]!, origin: "http://localhost:3000" },
        payload: { value },
      });
      expect(ok.statusCode).toBeLessThan(400);
      const refused = await app.inject({
        method: "PUT",
        url: `/api/secrets/${name}`,
        headers: { cookie: cookies["viewer"]!, origin: "http://localhost:3000" },
        payload: { value },
      });
      expect(refused.statusCode).toBe(403);

      const res = await get("admin", `/api/audit?action=secret.set&limit=50`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.version).toBe(1);
      const mine = body.events.filter((e: { target: string }) => e.target === name);
      expect(mine.map((e: { outcome: string }) => e.outcome).sort()).toEqual(["allow", "deny"]);
      const deny = mine.find((e: { outcome: string }) => e.outcome === "deny");
      expect(deny.detail).toMatchObject({
        role: "viewer",
        permission: "secret:write",
        status: 403,
      });
      expect(JSON.stringify(body)).not.toContain(value);

      const onlyDeny = await get("admin", "/api/audit?outcome=deny");
      expect(onlyDeny.json().events.every((e: { outcome: string }) => e.outcome === "deny")).toBe(
        true,
      );
    });

    it("pages with a cursor, newest first", async () => {
      const first = (await get("admin", "/api/audit?limit=1")).json();
      expect(first.events).toHaveLength(1);
      expect(first.nextCursor).toBeTruthy();
      const second = (await get("admin", `/api/audit?limit=1&cursor=${first.nextCursor}`)).json();
      expect(second.events[0].id).not.toBe(first.events[0].id);
      expect(new Date(second.events[0].at).getTime()).toBeLessThanOrEqual(
        new Date(first.events[0].at).getTime(),
      );
    });

    it("is for admins only, and rejects bad filters", async () => {
      expect((await get("editor", "/api/audit")).statusCode).toBe(403);
      expect((await get("admin", "/api/audit?outcome=maybe")).statusCode).toBe(400);
      expect((await get("admin", "/api/audit?since=yesterday-ish")).statusCode).toBe(400);
    });

    it("is append only: an update or a delete changes nothing", async () => {
      const before = (await get("admin", "/api/audit?limit=500")).json().events.length;
      expect(before).toBeGreaterThan(0);
      await withWorkspaceScope(db, workspaceId, (tx) =>
        tx.update(auditEvents).set({ actor: "tampered" }),
      );
      await withWorkspaceScope(db, workspaceId, (tx) => tx.delete(auditEvents));
      const after = (await get("admin", "/api/audit?limit=500")).json().events;
      expect(after.length).toBe(before);
      expect(after.some((e: { actor: string }) => e.actor === "tampered")).toBe(false);
    });
  });
});
