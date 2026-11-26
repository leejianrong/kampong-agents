import type { FastifyInstance } from "fastify";
import type { AuthInstance } from "../auth/config.js";
import type { DbClient } from "../db/client.js";
import { authorizeWorkspace } from "../auth/request-context.js";
import {
  AUDIT_EXPORT_VERSION,
  listAuditEvents,
  parseAuditLimit,
  type AuditOutcome,
} from "../audit/audit.js";

export interface AuditRoutesDeps {
  db: DbClient;
  auth: AuthInstance;
}

function parseDate(raw: unknown): Date | undefined | "invalid" {
  if (raw === undefined || raw === "") return undefined;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

export function registerAuditRoutes(app: FastifyInstance, { db, auth }: AuditRoutesDeps): void {
  // GET /api/audit -- the workspace's audit events, newest first, as versioned JSON a SIEM can poll (KAM-66).
  // Filters: action, actor, outcome (allow|deny), since, until (ISO times). Pages with `limit` (default 100, max 500)
  // and `cursor` (the previous response's nextCursor). Admins only.
  app.get<{
    Querystring: {
      limit?: string;
      cursor?: string;
      action?: string;
      actor?: string;
      outcome?: string;
      since?: string;
      until?: string;
    };
  }>("/api/audit", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply, "audit:read");
    if (!ctx) return reply;
    const q = request.query;
    const since = parseDate(q.since);
    const until = parseDate(q.until);
    if (since === "invalid" || until === "invalid") {
      return reply
        .code(400)
        .send({ success: false, error: "`since` and `until` must be ISO 8601 times." });
    }
    if (q.outcome !== undefined && q.outcome !== "allow" && q.outcome !== "deny") {
      return reply.code(400).send({ success: false, error: "`outcome` must be allow or deny." });
    }
    const result = await listAuditEvents(db, ctx.workspaceId, {
      limit: parseAuditLimit(q.limit),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.actor ? { actor: q.actor } : {}),
      ...(q.outcome ? { outcome: q.outcome as AuditOutcome } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
    });
    return { success: true, version: AUDIT_EXPORT_VERSION, ...result };
  });
}
