import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

// The minimal DB client this card (KAN-1223) owns: constructs a Drizzle
// client from a DATABASE_URL-shaped connection string. Needed to actually
// run migrations (../db/migrate.ts) and to give this card's own tests
// something concrete to exercise. Deliberately NOT wired into server.ts,
// any route, or wiring-check.ts's startup check -- consuming this for real
// spec/workspace CRUD is KAN-1224's job (this card's own "what NOT to
// build" scope).
//
// Driver: `pg` (node-postgres), Drizzle's own documented default driver for
// Postgres (orm.drizzle.team/docs/get-started/postgresql-new) -- a `Pool`
// rather than a single `Client` so a future caller (KAN-1224) gets
// connection pooling for free rather than having to add it later.

export type DbClient = NodePgDatabase<typeof schema>;

/**
 * Reads `DATABASE_URL` from the given env (defaults to `process.env`),
 * throwing a clear, actionable error if it isn't set. Shared by
 * `createDbClient` below and by `migrate.ts`, so both fail the same way.
 */
export function getDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. packages/server needs a Postgres connection string, e.g. " +
        "postgres://user:password@host:5432/dbname -- in a deployed cluster this is the `uri` " +
        "key of the CNPG-generated <cluster-name>-app Secret " +
        "(see deploy/helm/kampong-postgres/README.md).",
    );
  }
  return url;
}

/**
 * Constructs a `pg` connection pool and a Drizzle client bound to this
 * package's schema. Constructing a `Pool` does not itself open a network
 * connection (node-postgres connects lazily, on first query) -- safe to
 * call in a unit test with a syntactically valid but unreachable URL.
 */
export function createDbClient(databaseUrl: string = getDatabaseUrl()): {
  pool: Pool;
  db: DbClient;
} {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { pool, db };
}
