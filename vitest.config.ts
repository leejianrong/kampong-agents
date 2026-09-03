import { defineConfig } from "vitest/config";

// Test layering (dev-playbook): a no-infra "unit" layer that runs everywhere
// (local pre-push + every CI job), a heavier "integration" layer for
// cross-module/round-trip behavior, and an "e2e" layer for the full
// build-and-run acceptance checks (e.g. the exporter's behavioral-equivalence
// test: install and run the generated project, diff output).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "unit-web",
          include: ["apps/*/test/unit/**/*.test.{ts,tsx}"],
          environment: "jsdom",
        },
      },
      {
        test: {
          name: "integration",
          include: [
            "packages/*/test/integration/**/*.test.ts",
            "apps/*/test/integration/**/*.test.{ts,tsx}",
          ],
          environment: "node",
        },
      },
      {
        test: {
          name: "e2e",
          include: ["e2e/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
        },
      },
    ],
  },
});
