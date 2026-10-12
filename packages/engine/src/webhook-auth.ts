// Inbound webhook authentication, resolved (KAN-1848, ADR-0047). A webhook trigger names how its caller
// proves who it is: `auth` spells it out, `preset` expands a known sender (github, slack, alertmanager,
// generic) into the same thing. This file turns either into one concrete `ResolvedWebhookAuth` and says what
// is wrong when it cannot. It is pure (no imports, no I/O) because the spec validator and the engine's
// request handling must apply the exact same rules: `packages/spec/src/webhook-auth.ts` is a byte-identical
// copy of the engine's, enforced by a test, and the exporter vendors the engine's.
//
// A secret is never written in a spec. `secret_env` is the NAME of an environment variable (`GITHUB_SECRET`,
// or `${GITHUB_SECRET}`); a value that is not shaped like one is refused, and the message never repeats it.

export type WebhookPreset = "github" | "slack" | "alertmanager" | "generic";
export const WEBHOOK_PRESETS: readonly WebhookPreset[] = [
  "github",
  "slack",
  "alertmanager",
  "generic",
];

/** The fields a spec may write under `auth` (everything optional; which are needed depends on `type`). */
export interface WebhookAuthInput {
  type?: "none" | "bearer" | "hmac";
  secret_env?: string;
  header?: string;
  algo?: "sha256" | "sha1";
  prefix?: string;
  encoding?: "hex" | "base64";
  timestamp_header?: string;
  window_s?: number;
  payload?: string;
}

export interface ResolvedHmacAuth {
  type: "hmac";
  secretEnv: string;
  /** Lowercase name of the header that carries the signature. */
  header: string;
  algo: "sha256" | "sha1";
  /** Text in front of the digest in the header (`sha256=`); empty when there is none. */
  prefix: string;
  encoding: "hex" | "base64";
  /** The header that carries the signing time, when the sender signs one. */
  timestampHeader?: string;
  /** How far (seconds) the signing time may be from now; present exactly when `timestampHeader` is. */
  windowS?: number;
  /** What is signed, with `{body}` and `{timestamp}` standing for the raw body and the timestamp header. */
  payload: string;
}
export type ResolvedWebhookAuth =
  | { type: "none" }
  | { type: "bearer"; secretEnv: string; header: "authorization" }
  | ResolvedHmacAuth;

export interface WebhookAuthIssue {
  /** Path under the trigger: `["auth", "secret_env"]`, `["preset"]`. */
  path: string[];
  message: string;
}

export const DEFAULT_WINDOW_S = 300;

const PRESETS: Record<WebhookPreset, WebhookAuthInput> = {
  // GitHub: X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256 of the raw body.
  github: { type: "hmac", header: "x-hub-signature-256", algo: "sha256", prefix: "sha256=" },
  // Slack: X-Slack-Signature = "v0=" + hex HMAC-SHA256 of "v0:<timestamp>:<body>", the timestamp in
  // X-Slack-Request-Timestamp, refused when more than five minutes from now.
  slack: {
    type: "hmac",
    header: "x-slack-signature",
    algo: "sha256",
    prefix: "v0=",
    timestamp_header: "x-slack-request-timestamp",
    window_s: DEFAULT_WINDOW_S,
    payload: "v0:{timestamp}:{body}",
  },
  // Alertmanager has no signing: its webhook_configs send `Authorization: Bearer <token>`.
  alertmanager: { type: "bearer" },
  // A sender with a plain body signature and no prefix.
  generic: { type: "hmac", header: "x-signature", algo: "sha256" },
};

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

/** `NAME` or `${NAME}` as the variable's name; undefined when it is not shaped like an env var name. */
export function secretEnvName(value: string): string | undefined {
  const inner = /^\$\{([^}]*)\}$/.exec(value.trim())?.[1] ?? value.trim();
  return ENV_NAME.test(inner) ? inner : undefined;
}

export type ResolveResult =
  { ok: true; auth: ResolvedWebhookAuth } | { ok: false; issues: WebhookAuthIssue[] };

const HMAC_ONLY = [
  "header",
  "algo",
  "prefix",
  "encoding",
  "timestamp_header",
  "window_s",
  "payload",
] as const;

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Expands `preset` and `auth` into one concrete rule, or lists what is wrong with them. */
export function resolveWebhookAuth(
  preset: WebhookPreset | undefined,
  authInput: WebhookAuthInput | "none" | undefined,
): ResolveResult {
  const issues: WebhookAuthIssue[] = [];
  const issue = (path: string[], message: string) => issues.push({ path, message });
  const auth: WebhookAuthInput | undefined = authInput === "none" ? { type: "none" } : authInput;
  if (preset !== undefined && auth?.type === "none") {
    issue(["auth", "type"], `a preset (${preset}) signs requests: auth cannot be "none" with it`);
    return { ok: false, issues };
  }
  const base = preset ? PRESETS[preset] : {};
  if (preset && auth?.type !== undefined && auth.type !== base.type) {
    issue(
      ["auth", "type"],
      `preset ${preset} uses ${base.type} authentication: auth.type "${auth.type}" does not match`,
    );
  }
  const merged: WebhookAuthInput = { ...base, ...stripUndefined(auth ?? {}) };
  const type = merged.type;
  if (type === undefined) {
    if (auth === undefined) return { ok: true, auth: { type: "none" } };
    issue(["auth", "type"], 'auth needs a type: "none", "bearer" or "hmac" (or use a preset)');
    return { ok: false, issues };
  }
  if (type === "none") {
    for (const f of ["secret_env", ...HMAC_ONLY] as const) {
      if (auth && auth[f] !== undefined) issue(["auth", f], `${f} does not apply to auth "none"`);
    }
    return issues.length ? { ok: false, issues } : { ok: true, auth: { type: "none" } };
  }

  const what = preset ? `preset ${preset}` : `auth "${type}"`;
  let secretEnv: string | undefined;
  if (merged.secret_env === undefined) {
    issue(
      auth ? ["auth"] : ["preset"],
      `${what} needs auth.secret_env, the name of the environment variable that holds the secret`,
    );
  } else {
    secretEnv = secretEnvName(merged.secret_env);
    if (secretEnv === undefined) {
      // The value is not repeated: if it is a literal secret, an error message must not leak it.
      issue(
        ["auth", "secret_env"],
        "secret_env must be the NAME of an environment variable (like GITHUB_WEBHOOK_SECRET or ${GITHUB_WEBHOOK_SECRET}), not the secret itself",
      );
    }
  }

  if (type === "bearer") {
    for (const f of HMAC_ONLY) {
      if (auth && auth[f] !== undefined) issue(["auth", f], `${f} only applies to auth "hmac"`);
    }
    if (issues.length || secretEnv === undefined) return { ok: false, issues };
    return { ok: true, auth: { type: "bearer", secretEnv, header: "authorization" } };
  }

  // hmac
  let header: string | undefined;
  if (merged.header === undefined) {
    issue(
      auth ? ["auth"] : ["preset"],
      'auth "hmac" needs header, the name of the header that carries the signature',
    );
  } else if (!HEADER_NAME.test(merged.header)) {
    issue(["auth", "header"], "header must be a header name (letters, digits and hyphens)");
  } else {
    header = merged.header.toLowerCase();
  }
  let timestampHeader: string | undefined;
  if (merged.timestamp_header !== undefined) {
    if (!HEADER_NAME.test(merged.timestamp_header)) {
      issue(
        ["auth", "timestamp_header"],
        "timestamp_header must be a header name (letters, digits and hyphens)",
      );
    } else {
      timestampHeader = merged.timestamp_header.toLowerCase();
    }
  }
  if (merged.window_s !== undefined && merged.timestamp_header === undefined) {
    issue(
      ["auth", "window_s"],
      "window_s needs timestamp_header: a window is measured on the timestamp the sender signs",
    );
  }
  const payload = merged.payload ?? (timestampHeader ? "{timestamp}.{body}" : "{body}");
  if (!payload.includes("{body}")) {
    issue(["auth", "payload"], "payload must contain {body}, the raw request body");
  }
  if (payload.includes("{timestamp}") && merged.timestamp_header === undefined) {
    issue(["auth", "payload"], "payload uses {timestamp} but there is no timestamp_header");
  }
  if (issues.length || secretEnv === undefined || header === undefined) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    auth: {
      type: "hmac",
      secretEnv,
      header,
      algo: merged.algo ?? "sha256",
      prefix: merged.prefix ?? "",
      encoding: merged.encoding ?? "hex",
      ...(timestampHeader && { timestampHeader, windowS: merged.window_s ?? DEFAULT_WINDOW_S }),
      payload,
    },
  };
}
