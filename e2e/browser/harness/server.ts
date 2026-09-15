import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient, createServer, runMigrations } from "@kampong/server";
import { fakeModel, fetchImpl } from "./fixtures.js";

// The listening server the Playwright `webServer` starts for the browser E2E.
// Boots the real hosted server (packages/server) exactly as main.ts does --
// migrate a throwaway Postgres, connect, serve the built canvas from one origin
// -- but with the `createModel`/`fetchImpl` test seams wired in so runs are
// deterministic and offline (see ./fixtures.ts). Requires DATABASE_URL to point
// at a throwaway database owned by a NON-superuser role (so FORCE RLS actually
// applies, KAN-1388); the CI browser job and the local docker instructions in
// playwright.config.ts both provide one.

const PORT = Number(process.env["PORT"] ?? 8099);
const HOST = "127.0.0.1";

// Repo root is four levels up from e2e/browser/harness/server.ts.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const staticDir = join(repoRoot, "apps", "canvas", "dist");

function requireEnv(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for the browser E2E harness -- point it at a throwaway " +
        "Postgres database owned by a non-superuser role. See playwright.config.ts.",
    );
  }
  return url;
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv();

  if (!existsSync(staticDir)) {
    throw new Error(
      `Canvas assets not found at ${staticDir}. Run \`npm run build\` before the browser E2E.`,
    );
  }

  // The server reads these at construction (createAuth) / at BYOK save time.
  // Fixed test values -- never production secrets.
  process.env["BETTER_AUTH_SECRET"] ??= "browser-e2e-secret-not-for-prod-0123456789";
  process.env["BETTER_AUTH_URL"] ??= `http://${HOST}:${PORT}`;
  // 32 bytes, base64 -- the BYOK envelope root key (ADR-0016).
  process.env["BYOK_ROOT_KEY"] ??= Buffer.alloc(32, 7).toString("base64");
  // No GitHub OAuth app in the harness -- email+password only.
  delete process.env["GITHUB_CLIENT_ID"];
  delete process.env["GITHUB_CLIENT_SECRET"];

  await runMigrations(databaseUrl);
  const { db } = createDbClient(databaseUrl);
  const app = createServer({ staticDir, db, run: { createModel: fakeModel, fetchImpl } });

  await app.listen({ port: PORT, host: HOST });
  console.log(`browser-e2e harness listening at http://${HOST}:${PORT}`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `browser-e2e harness failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
