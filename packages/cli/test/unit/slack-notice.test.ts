import { describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { slackApprovalNotice } from "../../src/slack-notice.js";

// KAM-124 (ADR-0049): the one honest message about Slack approvals on a laptop.

const spec = (withNotifier: boolean): AgentSpec =>
  ({
    version: "1.0",
    agent: {
      id: "a",
      name: "A",
      role: "R",
      goal: "G",
      ...(withNotifier && {
        approval_notifier: { type: "slack", token: "${SLACK_BOT_TOKEN}", channel: "#c" },
      }),
      workflow: [{ step: "s", action: "generate_text" }],
    },
  }) as unknown as AgentSpec;

describe("slackApprovalNotice", () => {
  it("says nothing for a spec that does not use Slack approvals", () => {
    for (const command of ["dev", "serve"] as const) {
      expect(slackApprovalNotice(spec(false), { command, env: {} })).toEqual([]);
    }
  });

  it("tells `serve` what Slack needs: a public URL, the one Request URL, Socket Mode off, and no tunnel", () => {
    const text = slackApprovalNotice(spec(true), {
      command: "serve",
      env: { SLACK_SIGNING_SECRET: "x" },
      host: "0.0.0.0",
      port: 8080,
    }).join("\n");
    expect(text).toContain("public HTTPS URL");
    expect(text).toContain("does not start a tunnel");
    expect(text).toContain("http://localhost:8080");
    expect(text).toContain("/slack/interactions");
    expect(text).toContain("one Request URL");
    expect(text).toContain("Socket Mode must be OFF");
    expect(text).toContain("POST /runs/<id>/approve");
    expect(text).not.toContain("SLACK_SIGNING_SECRET is not set");
  });

  it("warns when the signing secret is missing, since every click would be refused", () => {
    const lines = slackApprovalNotice(spec(true), { command: "serve", env: {} });
    expect(lines.join("\n")).toContain("SLACK_SIGNING_SECRET is not set");
  });

  it("tells `dev` that the canvas uses its own dialog and where the Slack buttons can be tried", () => {
    const text = slackApprovalNotice(spec(true), { command: "dev", env: {} }).join("\n");
    expect(text).toContain("in-app dialog");
    expect(text).toContain("kampong serve");
    expect(text).not.toContain("Socket Mode");
  });
});
