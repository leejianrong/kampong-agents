import { defineConfig } from "drizzle-kit";

// drizzle-kit configuration (ADR-0014, KAN-1223) -- generates SQL migration
// files into packages/server/drizzle/ by diffing src/db/schema.ts against
// the previous migration snapshot. Run via `npm run db:generate`
// (package.json). `dbCredentials` is only consulted by drizzle-kit commands
// that talk to a live database (`push`, `migrate`, `studio`) -- this
// package's own deploy-time migration runner (src/db/migrate.ts) does not
// go through drizzle-kit at all (see its own docstring for why), so
// DATABASE_URL only needs to be set here for local, ad hoc use of those
// other drizzle-kit commands, not for `db:generate` or the production Job.

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "",
  },
});
