// Deliberately simpler than incident-responder/support-triage's
// slack-approval.ts: this demo is the autonomous, no-HITL end of the
// spectrum (SLICES.md V5) -- a one-way real Slack notification, no
// Approve/Reject buttons, no interaction callback, no signing-secret
// verification, because nothing here ever waits on a human decision.

export class SlackApiError extends Error {
  constructor(method: string, error: string) {
    super(`Slack API call to ${method} failed: ${error}`);
    this.name = "SlackApiError";
  }
}

interface SlackChatPostMessageResponse {
  ok: boolean;
  error?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example).`);
  return value;
}

export async function postAnomalyAlert(text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("SLACK_BOT_TOKEN")}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: requireEnv("SLACK_CHANNEL"), text }),
  });
  const body = (await response.json()) as SlackChatPostMessageResponse;
  if (!response.ok || !body.ok) {
    throw new SlackApiError("chat.postMessage", body.error ?? `HTTP ${response.status}`);
  }
}
