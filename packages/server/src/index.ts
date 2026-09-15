// Library barrel for @kampong/server (ADR-0013, KAN-1221). Kept separate
// from main.ts deliberately, matching packages/cli's index.ts/cli.ts split:
// importing this module must never have the side effect of starting a
// listening process -- only running main.ts directly (or the built
// dist/main.js, e.g. from the Dockerfile's CMD) does that.

export const PACKAGE_NAME = "@kampong/server";

export { createServer, type CreateServerOptions } from "./server.js";
export { runStartupWiringCheck, type WiringCheckResult } from "./wiring-check.js";
export { PgSpecRepository, SpecNotFoundError } from "./db/spec-repository.js";
// Exported so the browser E2E harness (e2e/browser/harness) can boot a real
// listening server against a throwaway Postgres the same way main.ts does --
// migrate, connect, then createServer -- without duplicating that wiring.
export { createDbClient, type DbClient } from "./db/client.js";
export { runMigrations } from "./db/migrate.js";
