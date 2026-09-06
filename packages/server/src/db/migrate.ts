import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getDatabaseUrl } from "./client.js";

// The migration runner this card's deploy-time Kubernetes Job actually
// invokes in the built container image (KAN-1223's step 5:
// deploy/helm/kampong-server/templates/migrate-job.yaml runs
// `node packages/server/dist/db/migrate.js` against a DATABASE_URL sourced
// from the CNPG-generated `<cluster-name>-app` Secret).
//
// Deliberately uses Drizzle's own programmatic `migrate()` function
// (`drizzle-orm/node-postgres/migrator`) rather than shelling out to the
// `drizzle-kit migrate` CLI -- this is Drizzle's own documented pattern for
// "serverless or monolithic deployments" (orm.drizzle.team/docs/migrations)
// and means the production image only needs `drizzle-orm` (already a
// runtime dependency, see client.ts) plus the checked-in `drizzle/*.sql`
// migration files -- not the much heavier `drizzle-kit` devDependency,
// which needs to load and diff the TypeScript schema and has no reason to
// ship in a minimal prod image. `drizzle-kit` stays a devDependency, used
// only for `npm run db:generate` in local dev/CI (see package.json).
//
// `import.meta.url`-derived path (not a hardcoded relative string) so this
// resolves correctly regardless of the process's cwd, matching main.ts's
// own `resolveCanvasDistDir` reasoning. From the compiled
// dist/db/migrate.js, ../../drizzle lands at packages/server/drizzle --
// the Dockerfile's runtime stage copies that directory in alongside dist/.

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Applies every not-yet-applied SQL migration in `MIGRATIONS_FOLDER`
 * against `databaseUrl` (defaults to `DATABASE_URL` from the environment).
 * Uses a single-connection pool (`max: 1`) -- migrations run once,
 * sequentially, at deploy time; there is no benefit to pooling here and a
 * single connection keeps the Job's Postgres footprint minimal.
 */
export async function runMigrations(databaseUrl: string = getDatabaseUrl()): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  runMigrations()
    .then(() => {
      console.log(`kampong-server: migrations applied from ${MIGRATIONS_FOLDER}`);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `kampong-server: migration run failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exitCode = 1;
    });
}
