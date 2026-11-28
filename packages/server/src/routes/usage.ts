import type { FastifyInstance } from "fastify";
import type { AuthInstance } from "../auth/config.js";
import type { DbClient } from "../db/client.js";
import { authorizeWorkspace } from "../auth/request-context.js";
import type { HostedRunManager } from "../run/manager.js";
import { buildUsageReport, parseUsageDays } from "../usage/usage.js";

export interface UsageRoutesDeps {
  db: DbClient;
  auth: AuthInstance;
  manager: HostedRunManager;
}

// KAM-325: GET /api/usage?days=30 (default 30, at most 90): this workspace's runs, tokens and estimated cost by day
// and by deployment, with the monthly and concurrent run limits beside current use. Read-only, so every role that can
// read runs can read it. The response carries `version: 1`.
export function registerUsageRoutes(
  app: FastifyInstance,
  { db, auth, manager }: UsageRoutesDeps,
): void {
  app.get<{ Querystring: { days?: string } }>("/api/usage", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply, "run:read");
    if (!ctx) return reply;
    const report = await buildUsageReport(
      db,
      ctx.workspaceId,
      parseUsageDays(request.query.days),
      manager.runLimits,
    );
    return { success: true, ...report };
  });
}
