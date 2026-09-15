// KAN-1226 (ADR-0015): env-var config for Better Auth, following the same
// read-env-or-throw-clearly pattern src/db/client.ts's `getDatabaseUrl`
// already established for `DATABASE_URL` -- a required, security-sensitive
// value fails loudly and specifically at startup, never silently.

/**
 * Reads `BETTER_AUTH_SECRET` (the key Better Auth's own cookie
 * signing/session-token encryption is derived from) from the given env
 * (defaults to `process.env`), throwing a clear, actionable error if it
 * isn't set.
 *
 * Deliberately does NOT fall back to Better Auth's own built-in dev secret
 * (`"better-auth-secret-123456789"`, used when neither `BETTER_AUTH_SECRET`
 * nor `AUTH_SECRET` is set and `secret` isn't passed explicitly) -- that
 * fallback is silent outside of Better Auth's own narrow "NODE_ENV ===
 * production" check, which is exactly the kind of silent-degradation this
 * repo's own conventions (AGENTS.md: "a local model that's unavailable is a
 * hard, visible error, never a silent fallback") reject for a
 * security-sensitive value. Generate one with `openssl rand -base64 32`.
 */
export function getAuthSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env["BETTER_AUTH_SECRET"];
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. packages/server needs a session-signing secret -- " +
        "generate one with `openssl rand -base64 32` and set it as the BETTER_AUTH_SECRET " +
        "env var (in a deployed cluster this belongs in a Kubernetes Secret, never checked " +
        "into a spec or the repo).",
    );
  }
  return secret;
}

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Reads `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` from the given env
 * (defaults to `process.env`). Returns `undefined` -- not a thrown error --
 * when either is missing: unlike `DATABASE_URL`/`BETTER_AUTH_SECRET`,
 * GitHub OAuth is one of *two* sign-in methods this card wires up (ADR-0015
 * commits to both email+password and GitHub); a deployment/dev/test
 * environment with no GitHub OAuth app registered yet must still be able to
 * start the server and use email+password sign-in. This is the "the plugin
 * is simply not exercised live" branch of this card's own brief, not the
 * "fails clearly at startup" branch -- the caller (`createAuth`,
 * ./config.ts) logs a visible warning and omits the `github` social
 * provider entirely rather than registering a provider with empty
 * credentials.
 */
export function getGithubOAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): GithubOAuthConfig | undefined {
  const clientId = env["GITHUB_CLIENT_ID"];
  const clientSecret = env["GITHUB_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    return undefined;
  }
  return { clientId, clientSecret };
}

/**
 * Reads `BETTER_AUTH_URL` (Better Auth's own documented env var for its
 * `baseURL` option -- the origin GitHub OAuth callback URLs and CSRF/Origin
 * checks are computed against). Returns `undefined` when unset; Better
 * Auth's own fallback in that case is to derive an origin from each
 * incoming request (logged as a startup warning by Better Auth itself),
 * which is adequate for local dev/tests but should be set explicitly in any
 * real deployment.
 */
export function getAuthBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["BETTER_AUTH_URL"];
}
