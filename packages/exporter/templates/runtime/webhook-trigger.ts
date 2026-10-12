// Vendored from packages/engine/src/webhook-trigger.ts as part of a `kampong export`
// -- see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. The
// only change from the source file is any type import of the spec, which now comes from
// the local ./spec-types.js rather than "@kampong/spec" (this project has no
// dependency on that package -- ADR-0002). From here on this file is yours: it
// will not be touched again by a future export.
//
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { evaluateCondition, evaluateExpression, type ExpressionLimits } from "./expressions.js";
import {
  resolveWebhookAuth,
  type ResolvedWebhookAuth,
  type WebhookAuthInput,
} from "./webhook-auth.js";
import type { RunTrigger } from "./workflow.js";

// What happens to one POST /webhook before a run starts (KAN-1848, ADR-0047), in this order:
//   1. authenticate the caller against the raw bytes of the body (none / bearer / hmac, presets expanded);
//   2. answer Slack's url_verification handshake when the preset is slack;
//   3. `when`: a predicate over the request that drops one that should not start a run;
//   4. `map`: build the clean `trigger.*` the workflow reads.
// It is shared by `kampong serve` and the exporter's generated server (vendored, ADR-0010), so both treat a
// request the same way. Auth comes first so an unauthenticated caller learns nothing from `when`, `map`, or a
// `respond: sync` answer; the sync/async choice is the server's, made only after a decision of "run".

/** The webhook trigger as this file reads it (the spec's, structurally). */
export interface WebhookTriggerConfig {
  type: "webhook";
  preset?: string;
  auth?: WebhookAuthInput | "none";
  when?: string;
  map?: Record<string, string>;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  /** The body exactly as it arrived. A string is taken as UTF-8. */
  rawBody: Buffer | string;
}

export interface WebhookOptions {
  env?: NodeJS.ProcessEnv;
  /** Time in ms; a fixed clock in tests. */
  now?: () => number;
  limits?: Partial<ExpressionLimits>;
}

export type WebhookDecision =
  /** Start a run: `trigger` is what expressions read as `trigger`. The run input stays the body. */
  | { action: "run"; trigger: RunTrigger }
  /** The caller did not prove itself. Always the same answer, whatever the reason. */
  | { action: "reject"; status: 401; body: { success: false; error: "Unauthorized" } }
  /** Answer the caller directly (Slack's url_verification challenge); no run. */
  | { action: "respond"; status: 200; body: Record<string, unknown> }
  /** `when` was false: accepted but not run. `reason` is for the ignored record. */
  | { action: "ignore"; reason: string }
  /** `when` or `map` could not be evaluated: nothing ran. */
  | { action: "error"; status: 422; body: { success: false; error: string } };

const REJECT: WebhookDecision = {
  action: "reject",
  status: 401,
  body: { success: false, error: "Unauthorized" },
};

// A header that looks like a credential is not passed on, so it cannot end up in a message, a query or a run
// trace through `{{ trigger.headers }}`.
const CREDENTIAL_HEADER =
  /authorization|cookie|token|secret|signature|api-?key|password|credential|x-amz-security/i;

/** Request headers as `trigger.headers` reads them: lowercase names, text values, credentials left out. */
export function triggerHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || CREDENTIAL_HEADER.test(name)) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** Constant-time equality; buffers of different length are not equal (timingSafeEqual would throw). */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toBuffer(raw: Buffer | string): Buffer {
  return typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
}

function verify(
  auth: ResolvedWebhookAuth,
  req: WebhookRequest,
  secret: string,
  nowMs: number,
): boolean {
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  if (auth.type === "bearer") {
    const match = /^bearer +(.+)$/i.exec(single(headers[auth.header]) ?? "");
    if (!match) return false;
    // Hashing both sides first makes the compared buffers equal in length whatever the token is.
    const digest = (s: string) => createHash("sha256").update(s).digest();
    return safeEqual(digest(match[1]!), digest(secret));
  }
  if (auth.type !== "hmac") return true;

  const received = single(headers[auth.header]);
  if (received === undefined) return false;
  let timestamp = "";
  if (auth.timestampHeader !== undefined) {
    timestamp = single(headers[auth.timestampHeader]) ?? "";
    // Seconds since the epoch, as text of digits only: anything else cannot be a signing time.
    if (!/^\d{1,12}$/.test(timestamp)) return false;
    if (Math.abs(nowMs / 1000 - Number(timestamp)) > (auth.windowS ?? 0)) return false;
  }
  // The signed bytes: the template with the raw body (exact bytes, never re-serialised) and the timestamp.
  const pieces: Buffer[] = [];
  for (const part of auth.payload.split(/(\{body\}|\{timestamp\})/)) {
    if (part === "{body}") pieces.push(toBuffer(req.rawBody));
    else if (part === "{timestamp}") pieces.push(Buffer.from(timestamp, "utf8"));
    else if (part !== "") pieces.push(Buffer.from(part, "utf8"));
  }
  const digest = createHmac(auth.algo, secret).update(Buffer.concat(pieces)).digest(auth.encoding);
  const norm = (s: string) => (auth.encoding === "hex" ? s.toLowerCase() : s);
  return safeEqual(
    Buffer.from(norm(auth.prefix + digest), "utf8"),
    Buffer.from(norm(received), "utf8"),
  );
}

/** The request body for expressions: parsed when it is JSON, as text when it is not. */
function readBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function handleWebhookRequest(
  trigger: WebhookTriggerConfig | undefined,
  req: WebhookRequest,
  options: WebhookOptions = {},
): Promise<WebhookDecision> {
  const env = options.env ?? process.env;
  const rawText = toBuffer(req.rawBody).toString("utf8");
  const preset = trigger?.preset;

  if (trigger && (trigger.preset !== undefined || trigger.auth !== undefined)) {
    const resolved = resolveWebhookAuth(
      trigger.preset as Parameters<typeof resolveWebhookAuth>[0],
      trigger.auth,
    );
    if (!resolved.ok) {
      // A spec that passed validation cannot get here; if one does, the endpoint stays closed.
      console.error("webhook: the trigger's auth is not valid; refusing every request");
      return REJECT;
    }
    if (resolved.auth.type !== "none") {
      const secret = env[resolved.auth.secretEnv];
      if (!secret) {
        // Names the variable, never a value. The caller still only sees the generic 401.
        console.error(`webhook: ${resolved.auth.secretEnv} is not set; refusing every request`);
        return REJECT;
      }
      const now = options.now ?? Date.now;
      if (!verify(resolved.auth, req, secret, now())) return REJECT;
    }
  }

  const body = readBody(rawText);
  if (preset === "slack" && body !== null && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (b.type === "url_verification" && typeof b.challenge === "string") {
      return { action: "respond", status: 200, body: { challenge: b.challenge } };
    }
  }

  const headers = triggerHeaders(req.headers);
  const fields =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const scope = { trigger: { ...fields, headers, body } };
  const run: RunTrigger = { headers, body };

  try {
    if (trigger?.when !== undefined) {
      if (!(await evaluateCondition(trigger.when, scope, options.limits))) {
        return { action: "ignore", reason: "the trigger's when predicate was false" };
      }
    }
    if (trigger?.map !== undefined) {
      const mapped: Record<string, unknown> = {};
      for (const [name, source] of Object.entries(trigger.map)) {
        // A field that selects nothing is null, so a workflow sees "the sender left it out" explicitly.
        mapped[name] = (await evaluateExpression(source, scope, options.limits)) ?? null;
      }
      run.fields = mapped;
    }
  } catch (err) {
    return {
      action: "error",
      status: 422,
      body: { success: false, error: `webhook trigger: ${(err as Error).message}` },
    };
  }
  return { action: "run", trigger: run };
}
