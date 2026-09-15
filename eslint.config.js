// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // `site/` is the generated Zensical docs build output (gitignored). ESLint's
    // flat config doesn't read .gitignore, so it must be ignored explicitly or a
    // local `zensical build` leaves thousands of bundled JS files for `eslint .`
    // (and the pre-push hook) to choke on.
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "e2e/fixtures/**", "site/**"],
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
