// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // `site/` is the generated Zensical docs build output (gitignored). ESLint's
    // flat config doesn't read .gitignore, so it must be ignored explicitly or a
    // local `zensical build` leaves thousands of bundled JS files for `eslint .`
    // (and the pre-push hook) to choke on. `mastra-projects/` is deliberately
    // outside the npm workspace/build/lint/CI entirely (ADR-0002 in
    // mastra-projects/docs/adr/) -- each demo there is its own independent
    // project with its own tooling, not code this repo's lint config governs.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "e2e/fixtures/**",
      "site/**",
      "mastra-projects/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["apps/canvas/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
  },
);
