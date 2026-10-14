import type { AgentSpec } from "@kampong/spec";

// KAM-124 (ADR-0049): what `kampong dev` and `kampong serve` say when a spec posts its approvals to Slack.
// Slack delivers a button click by calling a public HTTPS URL, which a laptop does not have. kampong does not
// start a tunnel; it says plainly what is needed, so the one silent failure (a click that never arrives) is
// never the first thing a person learns.

export interface SlackNoticeOptions {
  command: "dev" | "serve";
  env: NodeJS.ProcessEnv;
  host?: string;
  port?: number;
}

/** The lines to print for a spec that uses Slack approvals, or none for a spec that does not. */
export function slackApprovalNotice(spec: AgentSpec, options: SlackNoticeOptions): string[] {
  if (!spec.agent.approval_notifier) return [];
  const { command, env, host = "localhost", port } = options;

  if (command === "dev") {
    return [
      "note: this spec posts approvals to Slack (approval_notifier), but `kampong dev` does not: in the canvas an",
      "      approval is the in-app dialog, so nothing needs to be public here. To try the Slack buttons run",
      "      `kampong serve` behind a public HTTPS URL (docs: tutorial/slack-approvals).",
    ];
  }

  const local = `http://${host === "0.0.0.0" ? "localhost" : host}${port === undefined ? "" : `:${port}`}`;
  const lines = [
    "Slack approvals need a public HTTPS URL; Slack cannot call localhost, and kampong does not start a tunnel:",
    `  1. Expose ${local} yourself (ngrok, cloudflared, or any reverse proxy).`,
    "  2. In the Slack app, Interactivity & Shortcuts: ON, Request URL https://<your-public-host>/slack/interactions.",
    "     An app has one Request URL, so a second spec or environment needs its own app.",
    "  3. Socket Mode must be OFF. With it on Slack sends clicks over a websocket and no request ever arrives.",
    "  Until then the run still pauses; resolve it with POST /runs/<id>/approve or POST /approvals/<key>/approve.",
  ];
  if (!env.SLACK_SIGNING_SECRET) {
    lines.push(
      "warning: SLACK_SIGNING_SECRET is not set, so every Slack click will be refused with 401 (the check fails closed).",
    );
  }
  return lines;
}
