import type { WebhookTrigger } from "@kampong/spec";

// KAM-317: what a person needs to send the first accepted request to `kampong serve`: the command, the URL, the
// header the sender must set and a curl to try. The auth rules mirror the engine's presets (webhook-auth.ts); only
// the shape needed to describe them is here, so the canvas does not bundle the engine.

export const SERVE_URL = "http://localhost:8080/webhook";

export interface GoLive {
  command: string;
  url: string;
  /** What the sender must send, in a sentence. Undefined for an open webhook. */
  needs?: string;
  /** The variable holding the secret, when there is one. */
  secretEnv?: string;
  /** A command that sends a request, with the secret read from the environment. Empty when the sender signs. */
  curl: string;
}

const HMAC_PRESET_HEADER: Record<string, string> = {
  github: "X-Hub-Signature-256",
  slack: "X-Slack-Signature",
  generic: "X-Signature",
};

const envName = (v: string | undefined): string | undefined =>
  v === undefined ? undefined : (/^\$\{([^}]*)\}$/.exec(v.trim())?.[1] ?? v.trim());

export function goLive(t: WebhookTrigger, file = "agent.yaml"): GoLive {
  const auth = t.auth === "none" || t.auth === undefined ? undefined : t.auth;
  const secretEnv = envName(auth?.secret_env);
  const type =
    auth?.type ?? (t.preset === "alertmanager" ? "bearer" : t.preset ? "hmac" : undefined);
  const command = `kampong serve ${file}`;
  const body = `-H "content-type: application/json" -d '{"hello":"world"}'`;
  if (type === "bearer") {
    return {
      command,
      url: SERVE_URL,
      needs: `an Authorization header: Bearer, then the value of ${secretEnv ?? "the secret variable"}`,
      ...(secretEnv && { secretEnv }),
      curl: `curl -X POST ${SERVE_URL} \\\n  -H "authorization: Bearer $${secretEnv ?? "TOKEN"}" \\\n  ${body}`,
    };
  }
  if (type === "hmac") {
    const header =
      auth?.header ?? (t.preset ? HMAC_PRESET_HEADER[t.preset] : undefined) ?? "a signature header";
    return {
      command,
      url: SERVE_URL,
      needs: `a signature in ${header}, made by the sender with ${secretEnv ?? "the secret variable"}`,
      ...(secretEnv && { secretEnv }),
      // A signature cannot be typed by hand, so there is no curl: the real sender makes it.
      curl: "",
    };
  }
  return { command, url: SERVE_URL, curl: `curl -X POST ${SERVE_URL} ${body}` };
}
