// Vendored from packages/engine/src/slack-approval.ts as part of a `kampong
// export` -- see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md.
// No changes from the source file (it has no @kampong/spec dependency to
// adapt -- it only knows about Slack's plain HTTP APIs). From here on this
// file is yours: it will not be touched again by a future export.
//
import { createHmac, timingSafeEqual } from "node:crypto";

// KAN-1432 (ADR-0021 Slice D): headless-approval notifications over Slack --
// when a run pauses for a human decision with no canvas attached (`kampong
// serve` / the exported app), post an interactive Approve/Reject message
// instead of relying on someone watching a UI. This module only knows about
// Slack's plain HTTP APIs (chat.postMessage, its Block Kit interactive-
// message shape, and the request-signature scheme for verifying an inbound
// interaction callback) -- no dependency on AgentSpec or the workflow
// engine, so it vendors byte-identically into an exported project (ADR-0010)
// alongside http-tool.ts/model.ts.

const APPROVE_ACTION_ID = "kampong_approve";
const REJECT_ACTION_ID = "kampong_reject";

/** Slack's Block Kit shape for an interactive Approve/Reject message; the button `value` carries the run id so the interaction callback (below) knows which run to resolve. */
export function buildApprovalBlocks(runId: string, text: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: APPROVE_ACTION_ID,
          value: JSON.stringify({ runId }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: REJECT_ACTION_ID,
          value: JSON.stringify({ runId }),
        },
      ],
    },
  ];
}

export class SlackApiError extends Error {
  constructor(method: string, error: string) {
    super(`Slack API call to ${method} failed: ${error}`);
    this.name = "SlackApiError";
  }
}

interface SlackChatPostMessageResponse {
  ok: boolean;
  error?: string;
  channel?: string;
  ts?: string;
}

export interface PostApprovalRequestInput {
  token: string;
  channel: string;
  runId: string;
  text: string;
}

/**
 * Posts the interactive Approve/Reject message. Throws SlackApiError on a
 * non-ok Slack response or network failure -- a headless approval that
 * silently fails to notify anyone defeats the whole point of this feature
 * (fail visibly, AGENTS.md), it must not be swallowed.
 */
export async function postApprovalRequest(
  { token, channel, runId, text }: PostApprovalRequestInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ channel: string; ts: string }> {
  const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text, blocks: buildApprovalBlocks(runId, text) }),
  });
  const body = (await response.json()) as SlackChatPostMessageResponse;
  if (!response.ok || !body.ok) {
    throw new SlackApiError("chat.postMessage", body.error ?? `HTTP ${response.status}`);
  }
  return { channel: body.channel!, ts: body.ts! };
}

/**
 * Replaces the original message (via its one-time `response_url`, supplied
 * by Slack in the interaction payload -- no separate token needed) with the
 * resolved outcome, removing the buttons so a second click can't re-resolve
 * an already-decided run. Best-effort: a failure here doesn't undo the
 * approval decision, which has already been applied by the time this runs.
 */
export async function postInteractionUpdate(
  responseUrl: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await fetchImpl(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: true, text }),
  });
}

// --- Inbound interaction verification -----------------------------------

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export interface VerifySlackSignatureInput {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
  /** Injectable for deterministic tests; defaults to the real clock. */
  now?: () => number;
}

/**
 * Slack's request-signature scheme (see Slack's "Verifying requests from
 * Slack" docs): HMAC-SHA256 of `v0:{timestamp}:{rawBody}` under the app's
 * signing secret, compared against the `X-Slack-Signature` header in
 * constant time. Also rejects a stale timestamp (replay protection) -- both
 * checks must pass for the interaction to be trusted. This is the one thing
 * standing between "an authenticated human clicked Approve in Slack" and "a
 * stranger who found the callback URL POSTed a fake approval".
 */
export function verifySlackSignature({
  signingSecret,
  timestamp,
  rawBody,
  signature,
  now = () => Date.now(),
}: VerifySlackSignatureInput): boolean {
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(now() / 1000 - timestampSeconds) > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export interface SlackInteraction {
  actionId: string;
  runId: string;
  responseUrl: string;
  userName?: string;
}

/**
 * Parses Slack's `application/x-www-form-urlencoded` interaction callback
 * body (a single `payload=<url-encoded JSON>` field) into the fields this
 * feature needs. Returns undefined for anything that doesn't match the
 * expected shape -- an honest "not a recognized interaction", not a guess.
 */
export function parseSlackInteractionPayload(rawBody: string): SlackInteraction | undefined {
  const params = new URLSearchParams(rawBody);
  const raw = params.get("payload");
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const payload = parsed as {
    actions?: { action_id?: string; value?: string }[];
    response_url?: string;
    user?: { username?: string; name?: string };
  };
  const action = payload.actions?.[0];
  if (!action?.action_id || !action.value || !payload.response_url) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(action.value);
  } catch {
    return undefined;
  }
  const runId = (value as { runId?: unknown } | null)?.runId;
  if (typeof runId !== "string") return undefined;

  return {
    actionId: action.action_id,
    runId,
    responseUrl: payload.response_url,
    userName: payload.user?.username ?? payload.user?.name,
  };
}

export function isApproveAction(actionId: string): boolean {
  return actionId === APPROVE_ACTION_ID;
}

export function isRejectAction(actionId: string): boolean {
  return actionId === REJECT_ACTION_ID;
}
