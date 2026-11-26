import { and, desc, eq, gte, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DbClient } from "../db/client.js";
import { withWorkspaceScope } from "../db/workspace-scope.js";
import { auditEvents } from "../db/schema.js";

// KAM-66: the audit log. Two writers and one reader.
//
// - A role refusal writes a "deny" event where it happens (authorizeWorkspace).
// - Every other mutating session route is audited by ONE onResponse hook, so a new route cannot forget to be:
//   authorizeWorkspace marks the request as audited, and the hook writes an "allow" event when a mutating
//   request answered below 400. Failed attempts (404, 409, 422) change nothing and are not recorded.
// - GET /api/audit exports the events (routes/audit.ts).
//
// An event holds who, what, on which target and what the role check said. `detail` carries the method, the route
// pattern, the status and the caller's address, never a request body, so a secret value cannot land in it.
// A failed write is logged and does not fail the request: an outage of the audit table must not take the product
// down, and the log line is the alarm. (A buyer who wants fail-closed can ask for it; the trade-off is documented.)

export type AuditOutcome = "allow" | "deny";

export interface AuditEventInput {
  workspaceId: string;
  actor: string;
  action: string;
  target?: string | null;
  outcome: AuditOutcome;
  detail?: Record<string, unknown>;
}

/** Friendly names for the routes people care about. Any other mutating route is recorded as "METHOD pattern". */
const ACTION_NAMES: Record<string, string> = {
  "POST /api/specs": "spec.create",
  "PUT /api/specs/:id": "spec.edit",
  "PUT /api/specs/:id/source": "spec.replace_source",
  "PUT /api/specs/:id/layout": "spec.layout",
  "POST /api/specs/:id/runs": "run.start",
  "POST /api/runs/:id/approve": "approval.decide",
  "PUT /api/specs/:id/deployment": "deployment.deploy",
  "PATCH /api/specs/:id/deployment": "deployment.set_status",
  "DELETE /api/specs/:id/deployment": "deployment.delete",
  "POST /api/specs/:id/deployment/webhook-secret": "deployment.rotate_secret",
  "PUT /api/secrets/:name": "secret.set",
  "DELETE /api/secrets/:name": "secret.delete",
  "PUT /api/byok/:provider": "byok.set",
  "DELETE /api/byok/:provider": "byok.delete",
};

export function auditActionName(method: string, routePattern: string): string {
  const key = `${method} ${routePattern}`;
  return ACTION_NAMES[key] ?? key;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface AuditMark {
  workspaceId: string;
  userId: string;
  role: string;
  permission: string;
}

// Set by authorizeWorkspace, read by the hook. A WeakMap keeps it off the Fastify types.
const marks = new WeakMap<FastifyRequest, AuditMark>();

export function markAudited(request: FastifyRequest, mark: AuditMark): void {
  marks.set(request, mark);
}

function requestDetail(
  request: FastifyRequest,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    method: request.method,
    route: request.routeOptions?.url ?? request.url.split("?")[0],
    ip: request.ip,
    ...extra,
  };
}

/** The `:id`-style target of a request: the first path parameter, if any. */
function targetOf(request: FastifyRequest): string | null {
  const params = request.params as Record<string, unknown> | undefined;
  const first = params ? Object.values(params)[0] : undefined;
  return typeof first === "string" ? first : null;
}

export async function recordAudit(db: DbClient, event: AuditEventInput): Promise<void> {
  try {
    await withWorkspaceScope(db, event.workspaceId, (tx) =>
      tx.insert(auditEvents).values({
        workspaceId: event.workspaceId,
        actor: event.actor,
        action: event.action,
        target: event.target ?? null,
        outcome: event.outcome,
        detail: event.detail ?? {},
      }),
    );
  } catch (err) {
    console.error(`Writing audit event ${event.action} failed:`, err);
  }
}

/** Called when a role refuses a request. */
export async function recordDenied(
  db: DbClient,
  request: FastifyRequest,
  mark: AuditMark,
): Promise<void> {
  await recordAudit(db, {
    workspaceId: mark.workspaceId,
    actor: mark.userId,
    action: auditActionName(request.method, request.routeOptions?.url ?? request.url),
    target: targetOf(request),
    outcome: "deny",
    detail: requestDetail(request, { role: mark.role, permission: mark.permission, status: 403 }),
  });
}

/** Writes an "allow" event for every mutating, authorized session request that succeeded. */
export function registerAuditHook(app: FastifyInstance, db: DbClient): void {
  app.addHook("onResponse", async (request, reply) => {
    if (!MUTATING.has(request.method)) return;
    const mark = marks.get(request);
    if (!mark || reply.statusCode >= 400) return;
    await recordAudit(db, {
      workspaceId: mark.workspaceId,
      actor: mark.userId,
      action: auditActionName(request.method, request.routeOptions?.url ?? request.url),
      target: targetOf(request),
      outcome: "allow",
      detail: requestDetail(request, {
        role: mark.role,
        permission: mark.permission,
        status: reply.statusCode,
      }),
    });
  });
}

// --- export -------------------------------------------------------------------------------------------------

export const AUDIT_EXPORT_VERSION = 1;
export const DEFAULT_AUDIT_LIMIT = 100;
export const MAX_AUDIT_LIMIT = 500;

export interface AuditQuery {
  limit?: number;
  cursor?: string;
  action?: string;
  actor?: string;
  outcome?: AuditOutcome;
  since?: Date;
  until?: Date;
}

export interface AuditEventView {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  outcome: string;
  detail: unknown;
}

/** Keyset cursor over (at, id), newest first: `<iso time>|<id>`, base64url. */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(cursor: string): { at: Date; id: string } | undefined {
  const [iso, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const at = iso ? new Date(iso) : undefined;
  if (!at || Number.isNaN(at.getTime()) || !id) return undefined;
  return { at, id };
}

export function parseAuditLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_AUDIT_LIMIT;
  return Math.min(n, MAX_AUDIT_LIMIT);
}

export async function listAuditEvents(
  db: DbClient,
  workspaceId: string,
  query: AuditQuery,
): Promise<{ events: AuditEventView[]; nextCursor?: string }> {
  const limit = query.limit ?? DEFAULT_AUDIT_LIMIT;
  const conditions: SQL[] = [eq(auditEvents.workspaceId, workspaceId)];
  if (query.action) conditions.push(eq(auditEvents.action, query.action));
  if (query.actor) conditions.push(eq(auditEvents.actor, query.actor));
  if (query.outcome) conditions.push(eq(auditEvents.outcome, query.outcome));
  if (query.since) conditions.push(gte(auditEvents.at, query.since));
  if (query.until) conditions.push(lte(auditEvents.at, query.until));
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  if (cursor) {
    conditions.push(
      or(
        lt(auditEvents.at, cursor.at),
        and(eq(auditEvents.at, cursor.at), sql`${auditEvents.id} < ${cursor.id}`),
      )!,
    );
  }
  const rows = await withWorkspaceScope(db, workspaceId, (tx) =>
    tx
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.at), desc(auditEvents.id))
      .limit(limit + 1),
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    events: page.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actor: r.actor,
      action: r.action,
      target: r.target,
      outcome: r.outcome,
      detail: r.detail,
    })),
    ...(rows.length > limit && last ? { nextCursor: encodeCursor(last.at, last.id) } : {}),
  };
}
