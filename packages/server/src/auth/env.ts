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

/** `PREVIEW_NOTICE` (KAM-320): the sentence the hosted canvas pins to the top of every screen. Unset or blank is none. */
export function getPreviewNotice(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env["PREVIEW_NOTICE"]?.trim();
  if (!raw) return undefined;
  if (raw.length > 300) throw new Error("PREVIEW_NOTICE must be 300 characters or fewer.");
  return raw;
}

/**
 * Reads `PUBLIC_BASE_URL` (KAM-321): the public origin this server is reached at, such as
 * `https://kampong.abangai.dev`. Webhook addresses shown to people are this plus the route's path, so they stay
 * right behind a proxy or when the public host is not the host the page was opened on. Returns `undefined` when
 * unset (the canvas then falls back to its own origin). A trailing slash is dropped. An unusable value throws
 * at startup: a wrong address printed to a customer is worse than a refused start.
 */
export function getPublicBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env["PUBLIC_BASE_URL"]?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `PUBLIC_BASE_URL is not a valid URL: "${raw}". Use an origin such as https://kampong.abangai.dev.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`PUBLIC_BASE_URL must start with http:// or https://, got "${raw}".`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    throw new Error(
      `PUBLIC_BASE_URL must be an origin with no path, query or fragment, got "${raw}".`,
    );
  }
  return url.origin;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a whole number of at least 1, got "${raw}".`);
  }
  return n;
}

/**
 * Reads the public webhook ingress limits (KAM-322): `INGRESS_DEPLOYMENT_PER_MINUTE`, `INGRESS_IP_PER_MINUTE` and
 * `INGRESS_MAX_BODY_BYTES`. Each one that is unset is left out, so the defaults in run/rate-limit.ts apply.
 */
export function getIngressLimits(env: NodeJS.ProcessEnv = process.env): {
  deploymentPerMinute?: number;
  ipPerMinute?: number;
  maxBodyBytes?: number;
} {
  const deploymentPerMinute = positiveInt(env, "INGRESS_DEPLOYMENT_PER_MINUTE");
  const ipPerMinute = positiveInt(env, "INGRESS_IP_PER_MINUTE");
  const maxBodyBytes = positiveInt(env, "INGRESS_MAX_BODY_BYTES");
  return {
    ...(deploymentPerMinute !== undefined && { deploymentPerMinute }),
    ...(ipPerMinute !== undefined && { ipPerMinute }),
    ...(maxBodyBytes !== undefined && { maxBodyBytes }),
  };
}

function wholeNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a whole number of at least 0 (0 turns it off), got "${raw}".`);
  }
  return n;
}

/**
 * Reads the per-workspace run limits (KAM-323): `RUN_MAX_CONCURRENT`, `RUN_MAX_PER_MONTH` and `RUN_MAX_MINUTES`.
 * Each one that is unset is left out, so the defaults in run/limits.ts apply. 0 turns that limit off.
 */
export function getRunLimits(env: NodeJS.ProcessEnv = process.env): {
  maxConcurrent?: number;
  maxPerMonth?: number;
  maxRuntimeMs?: number;
} {
  const maxConcurrent = wholeNumber(env, "RUN_MAX_CONCURRENT");
  const maxPerMonth = wholeNumber(env, "RUN_MAX_PER_MONTH");
  const minutes = wholeNumber(env, "RUN_MAX_MINUTES");
  return {
    ...(maxConcurrent !== undefined && { maxConcurrent }),
    ...(maxPerMonth !== undefined && { maxPerMonth }),
    ...(minutes !== undefined && { maxRuntimeMs: minutes * 60_000 }),
  };
}

/** `TRUST_PROXY=true`: believe `X-Forwarded-For` (set only when the server sits behind an ingress controller). */
export function getTrustProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["TRUST_PROXY"] === "true";
}

/**
 * Reads `BYOK_ROOT_KEY` (KAN-1229/ADR-0016: the base64-encoded 32-byte root
 * key every stored BYOK provider key is AES-256-GCM-encrypted under) and
 * returns it as a `Buffer`, throwing a clear, actionable error if it is unset
 * or not exactly 32 bytes once base64-decoded.
 *
 * Same read-env-or-throw-clearly, no-silent-fallback discipline as
 * `getAuthSecret`/`getDatabaseUrl`: a missing or wrong-sized root key is a
 * deploy misconfiguration that must fail loudly, never degrade to a weak or
 * absent key. In a deployed cluster this is the value of the root Kubernetes
 * `Secret` (ADR-0016) mounted as an env var -- the single most sensitive
 * artifact in the deployment; losing it permanently breaks every stored key.
 * Generate one with `openssl rand -base64 32`.
 */
export function getByokRootKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const encoded = env["BYOK_ROOT_KEY"];
  if (!encoded) {
    throw new Error(
      "BYOK_ROOT_KEY is not set. packages/server needs a 32-byte root key (base64) to " +
        "encrypt stored BYOK provider keys -- generate one with `openssl rand -base64 32` and " +
        "set it as the BYOK_ROOT_KEY env var (in a deployed cluster this is the root Kubernetes " +
        "Secret from ADR-0016, never checked into a spec or the repo).",
    );
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error(
      `BYOK_ROOT_KEY must decode to exactly 32 bytes (a base64-encoded 256-bit key); got ` +
        `${key.length} bytes. Generate a correct one with \`openssl rand -base64 32\`.`,
    );
  }
  return key;
}
