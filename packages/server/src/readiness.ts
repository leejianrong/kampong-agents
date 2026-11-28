import { sql } from "drizzle-orm";
import type { DbClient } from "./db/client.js";

// KAM-330: what an uptime monitor and the chart's readiness probe ask. /healthz says the process is up and its wiring
// loaded; it stays true when the database is gone, which is what a liveness probe wants (do not restart the pod for a
// database outage) and what an uptime monitor must not use. /readyz asks the database one cheap question with a short
// deadline, so "the service answers but cannot do anything" shows up as down. It reveals only up or down.

export type Readiness = { ok: true; database: "ok" | "none" } | { ok: false; database: "down" };

export async function checkReadiness(
  db: Pick<DbClient, "execute"> | undefined,
  timeoutMs = 2000,
): Promise<Readiness> {
  if (!db) return { ok: true, database: "none" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("database check timed out")), timeoutMs);
      }),
    ]);
    return { ok: true, database: "ok" };
  } catch {
    return { ok: false, database: "down" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
