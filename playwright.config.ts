import { defineConfig, devices } from "@playwright/test";

// Browser E2E (KAN-1228 follow-up): drives the real hosted canvas in a
// headless browser against a throwaway Postgres, so the whole auth ->
// workspace -> BYOK -> spec -> run -> approve flow is exercised end to end (and
// screenshots for the docs are captured along the way). Separate from the
// vitest `e2e` project (which shells out to a generated Node project); this one
// needs a browser and a listening server, so it's its own Playwright run.
//
// Requires a throwaway Postgres owned by a NON-superuser role (a superuser
// bypasses FORCE RLS, KAN-1388). Locally:
//   docker run --rm -d --name kampong-pg-e2e -p 15434:5432 \
//     -e POSTGRES_PASSWORD=postgres postgres:18
//   docker exec kampong-pg-e2e psql -U postgres \
//     -c "CREATE ROLE app_test LOGIN PASSWORD 'app_test' NOSUPERUSER NOBYPASSRLS;" \
//     -c "CREATE DATABASE kampong_e2e OWNER app_test;"
//   npm run build
//   DATABASE_URL=postgres://app_test:app_test@localhost:15434/kampong_e2e \
//     npm run test:e2e:browser
//   docker stop kampong-pg-e2e

const PORT = 8099;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e/browser",
  testMatch: "**/*.spec.ts",
  // The flow test is inherently sequential (sign up -> run -> approve); no need
  // for parallelism, and one shared harness/DB keeps it simple.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"] ? "line" : "list",
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx tsx e2e/browser/harness/server.ts",
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
    env: { PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  },
});
