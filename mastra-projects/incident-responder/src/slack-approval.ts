import { createHmac, timingSafeEqual } from "node:crypto";

// Adapted from kampong-agents' own packages/engine/src/slack-approval.ts
// (KAN-1432) -- same real Slack Block Kit interactive-message shape and the
// same request-signature verification scheme, retargeted from "approve a
// paused run" to "acknowledge a proposed incident fix" (ADR-0004: this demo
// never executes anything on approval, it only records a real human
// decision).

const APPROVE_ACTION_ID = "incident_approve";
const REJECT_ACTION_ID = "incident_reject";

export function buildApprovalBlocks(incidentId: string, text: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve fix" },
          style: "primary",
          action_id: APPROVE_ACTION_ID,
          value: JSON.stringify({ incidentId }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: REJECT_ACTION_ID,
          value: JSON.stringify({ incidentId }),
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
  incidentId: string;
  text: string;
}

/** Posts the real interactive Approve/Reject message. Fails loudly on a non-ok Slack response -- a proposal nobody sees defeats the point (AGENTS.md). */
export async function postApprovalRequest(
  { token, channel, incidentId, text }: PostApprovalRequestInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ channel: string; ts: string }> {
  const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text, blocks: buildApprovalBlocks(incidentId, text) }),
  });
  const body = (await response.json()) as SlackChatPostMessageResponse;
  if (!response.ok || !body.ok) {
    throw new SlackApiError("chat.postMessage", body.error ?? `HTTP ${response.status}`);
  }
  return { channel: body.channel!, ts: body.ts! };
}

/** Replaces the original message via its one-time response_url, removing the buttons so a second click can't re-resolve an already-decided incident. */
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

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export interface VerifySlackSignatureInput {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
  now?: () => number;
}

/** Slack's request-signature scheme -- HMAC-SHA256 of `v0:{timestamp}:{rawBody}`, constant-time compared, plus replay protection via a timestamp window. */
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
  incidentId: string;
  responseUrl: string;
  userName?: string;
}

/** Parses Slack's `application/x-www-form-urlencoded` interaction callback body into the fields this demo needs. */
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
  const incidentId = (value as { incidentId?: unknown } | null)?.incidentId;
  if (typeof incidentId !== "string") return undefined;

  return {
    actionId: action.action_id,
    incidentId,
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
