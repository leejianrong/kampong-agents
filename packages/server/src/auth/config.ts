import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { sso } from "@better-auth/sso";
import * as schema from "../db/schema.js";
import type { DbClient } from "../db/client.js";
import { getAuthBaseUrl, getAuthSecret, getGithubOAuthConfig } from "./env.js";

// KAN-1226 (ADR-0015): Better Auth integration -- email+password and GitHub
// OAuth sign-in, server-side session cookies, the `organization` plugin
// mapped onto this project's existing `workspaces`/`workspace_members`
// tables (not a second, parallel workspace concept), and the `sso` plugin
// adopted now but dormant (V6 activates it later, per ADR-0015). See
// ../db/schema.ts for the tables this all reads/writes and why each one's
// shape is what it is.
//
// Deliberately NOT wired into any HTTP route middleware, spec-CRUD auth, or
// workspace-resolution logic here -- that's KAN-1227's job. This module's
// entire scope is "Better Auth's own sign-up/sign-in/session/OAuth-callback
// endpoints work end to end against this project's Postgres" (verified in
// test/integration/db/auth.test.ts), nothing more.

export type AuthInstance = ReturnType<typeof createAuth>;

/**
 * Constructs the Better Auth instance. Reads `BETTER_AUTH_SECRET` eagerly
 * (throws clearly if unset, matching `getDatabaseUrl`'s own pattern --
 * see ./env.ts) and `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` permissively
 * (omits the `github` social provider, with a visible warning, rather than
 * throwing, if either is unset -- email+password sign-in must still work
 * without a GitHub OAuth app configured).
 */
export function createAuth(db: DbClient, env: NodeJS.ProcessEnv = process.env) {
  const githubConfig = getGithubOAuthConfig(env);
  if (!githubConfig) {
    // Startup-time visibility, not a per-request log; matches this repo's
    // own "visible, not silent" gap convention (see this card's report/
    // AGENTS.md) rather than failing startup outright, since email+password
    // sign-in does not need this.
    console.warn(
      "[kampong-server] GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET are not set -- GitHub OAuth " +
        "sign-in is disabled. Email+password sign-in is unaffected.",
    );
  }

  return betterAuth({
    baseURL: getAuthBaseUrl(env),
    secret: getAuthSecret(env),

    database: drizzleAdapter(db, {
      provider: "pg",
      // Explicit model->table map (not the adapter's `db._.fullSchema`
      // fallback) so the `organization`/`member` model remaps below
      // (`modelName: "workspaces"` / `"workspace_members"`) resolve to
      // exactly these tables -- see the `organization` plugin config
      // below and each table's own comment in ../db/schema.ts.
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        workspaces: schema.workspaces,
        workspace_members: schema.workspaceMembers,
        invitation: schema.invitation,
        ssoProvider: schema.ssoProvider,
      },
    }),

    advanced: {
      database: {
        // Verified against Better Auth 1.7.3: for the Postgres case this
        // defers ID generation to the database's own column default
        // (`gen_random_uuid()`, via each table's `.defaultRandom()` in
        // ../db/schema.ts) rather than generating a non-UUID id in
        // application code -- required for `user.id`/`workspaces.id`/etc.
        // to stay genuinely `uuid`-typed and FK-compatible with the rest
        // of this schema (including KAN-1225's RLS policies, which cast
        // `current_setting('app.workspace_id', ...)` to `::uuid`).
        generateId: "uuid",
      },
    },

    // ADR-0015's own flagged gap, deliberately out of this card's scope:
    // no transactional email (SMTP relay) exists in this deployment yet,
    // so email verification and password-reset emails are not wired up.
    // `requireEmailVerification: false` means sign-up/sign-in works today
    // without one; turning it on is future work once SMTP exists.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },

    ...(githubConfig
      ? {
          socialProviders: {
            github: githubConfig,
          },
        }
      : {}),

    plugins: [
      // Maps Better Auth's organization/member primitives onto this
      // project's existing workspace vocabulary (ADR-0014/ADR-0015) --
      // not a second, parallel organization schema. Every other default
      // field on both models (name/slug/logo/createdAt/metadata;
      // userId/role/createdAt) already matches a same-named column on the
      // target table, so only `organizationId` needs remapping.
      organization({
        schema: {
          organization: {
            modelName: "workspaces",
          },
          member: {
            modelName: "workspace_members",
            fields: {
              organizationId: "workspaceId",
            },
          },
        },
      }),
      // Adopted now, dormant until V6 (ADR-0015): no SSO configuration or
      // login path is wired up here -- this only registers the plugin (and
      // its `sso_provider` table, ../db/schema.ts) so V6 can activate it
      // per-workspace later without an auth-system migration.
      sso(),
    ],
  });
}
