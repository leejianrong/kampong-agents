import { defineConfig, devices } from "@playwright/test";

// Local browser run (`make e2e-browser`): every spec that starts its own `kampong dev`, so no database and no
// harness server are needed. hosted-flow needs a throwaway Postgres and docs-screenshots needs the hosted
// harness, so both stay on playwright.config.ts (CI, and `make e2e-browser`'s hosted step).
export default defineConfig({
  testDir: "e2e/browser",
  testMatch: "**/*.spec.ts",
  testIgnore: ["**/hosted-flow.spec.ts", "**/docs-screenshots.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 90_000,
  use: { screenshot: "only-on-failure", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
