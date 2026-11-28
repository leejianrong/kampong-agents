import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { withWorkspaceScope } from "../db/workspace-scope.js";
import { runs, specs } from "../db/schema.js";
import type { RunLimits } from "../run/limits.js";

// KAM-325: what a workspace has used. Runs, model tokens and estimated cost, by day and by deployment, read from the
// `runs` table the run manager fills in as a run goes (tokens_in, tokens_out, cost_usd), plus the limits of KAM-323
// beside current use. Cost is the sum of the runs that had a price for their model; a model with no price (see
// MODEL_PRICING_JSON) adds tokens and no cost, and `costRuns` says how many runs the figure covers, so a shortfall is
// visible rather than hidden.

export interface UsageBucket {
  runs: number;
  tokensIn: number;
  tokensOut: number;
  /** Null when no run in the bucket had a priced model. */
  costUsd: number | null;
  /** How many of the runs the cost covers. */
  costRuns: number;
}

export interface UsageReport {
  version: 1;
  from: string;
  to: string;
  totals: UsageBucket;
  days: Array<UsageBucket & { day: string }>;
  deployments: Array<UsageBucket & { specId: string; name: string }>;
  limits: {
    monthlyRuns: { used: number; limit: number };
    concurrentRuns: { running: number; limit: number };
    maxRunMinutes: number;
  };
}

const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

export function parseUsageDays(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

interface Row {
  runs: number | string;
  tokens_in: number | string | null;
  tokens_out: number | string | null;
  cost: number | string | null;
  cost_runs: number | string;
}

export function toBucket(row: Row): UsageBucket {
  return {
    runs: Number(row.runs),
    tokensIn: Number(row.tokens_in ?? 0),
    tokensOut: Number(row.tokens_out ?? 0),
    costUsd: row.cost === null ? null : Number(row.cost),
    costRuns: Number(row.cost_runs),
  };
}

export async function buildUsageReport(
  db: DbClient,
  workspaceId: string,
  days: number,
  limits: RunLimits,
  now: Date = new Date(),
): Promise<UsageReport> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(today - (days - 1) * 86_400_000);
  const to = new Date(today + 86_400_000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const inRange = and(
    eq(runs.workspaceId, workspaceId),
    gte(runs.startedAt, from),
    lt(runs.startedAt, to),
  );

  return withWorkspaceScope(db, workspaceId, async (tx) => {
    const dayRows = await tx
      .select({
        day: sql<string>`to_char(date_trunc('day', ${runs.startedAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
        runs: sql<number>`count(*)::int`,
        tokens_in: sql<string>`coalesce(sum(${runs.tokensIn}), 0)::bigint`,
        tokens_out: sql<string>`coalesce(sum(${runs.tokensOut}), 0)::bigint`,
        cost: sql<string | null>`sum(${runs.costUsd})`,
        cost_runs: sql<number>`(count(${runs.costUsd}))::int`,
      })
      .from(runs)
      .where(inRange)
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const deploymentRows = await tx
      .select({
        specId: runs.specId,
        name: specs.name,
        runs: sql<number>`count(*)::int`,
        tokens_in: sql<string>`coalesce(sum(${runs.tokensIn}), 0)::bigint`,
        tokens_out: sql<string>`coalesce(sum(${runs.tokensOut}), 0)::bigint`,
        cost: sql<string | null>`sum(${runs.costUsd})`,
        cost_runs: sql<number>`(count(${runs.costUsd}))::int`,
      })
      .from(runs)
      .innerJoin(specs, eq(specs.id, runs.specId))
      .where(inRange)
      .groupBy(runs.specId, specs.name)
      .orderBy(sql`count(*) desc`);
    const [monthly] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.workspaceId, workspaceId), gte(runs.startedAt, monthStart)));
    const cutoff = new Date(
      Date.now() - (limits.maxRuntimeMs > 0 ? limits.maxRuntimeMs * 2 : 86_400_000),
    );
    const [running] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, workspaceId),
          eq(runs.status, "running"),
          gte(runs.startedAt, cutoff),
        ),
      );

    const dayBuckets = dayRows.map((r) => ({ day: r.day, ...toBucket(r) }));
    // The totals are the days added up, so the panel's headline and its table cannot disagree.
    const totals = dayBuckets.reduce<UsageBucket>(
      (acc, d) => ({
        runs: acc.runs + d.runs,
        tokensIn: acc.tokensIn + d.tokensIn,
        tokensOut: acc.tokensOut + d.tokensOut,
        costUsd: d.costUsd === null ? acc.costUsd : (acc.costUsd ?? 0) + d.costUsd,
        costRuns: acc.costRuns + d.costRuns,
      }),
      { runs: 0, tokensIn: 0, tokensOut: 0, costUsd: null, costRuns: 0 },
    );
    return {
      version: 1 as const,
      from: from.toISOString().slice(0, 10),
      to: new Date(to.getTime() - 1).toISOString().slice(0, 10),
      totals,
      days: dayBuckets,
      deployments: deploymentRows.map((r) => ({ specId: r.specId, name: r.name, ...toBucket(r) })),
      limits: {
        monthlyRuns: { used: monthly?.n ?? 0, limit: limits.maxPerMonth },
        concurrentRuns: { running: running?.n ?? 0, limit: limits.maxConcurrent },
        maxRunMinutes: Math.round(limits.maxRuntimeMs / 60_000),
      },
    };
  });
}
