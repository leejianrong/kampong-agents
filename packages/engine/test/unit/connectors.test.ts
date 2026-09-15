import { describe, expect, it } from "vitest";
import type { Tool } from "@kampong/spec";
import {
  buildToolRequest,
  callHttpTool,
  resolveEnvValue,
  type ToolFetchImpl,
} from "../../src/http-tool.js";

// KAN-1430 (ADR-0021): Gmail + Slack connectors. Credential tokens resolve
// from ${ENV}; connector fields support {{ step.field }} references; the token
// travels in an Authorization header (never the URL or body).

describe("resolveEnvValue", () => {
  it("resolves a ${ENV} placeholder from the environment", () => {
    expect(resolveEnvValue("${SLACK_BOT_TOKEN}", { SLACK_BOT_TOKEN: "xoxb-1" })).toBe("xoxb-1");
  });
  it("throws a clear error when the env var is unset", () => {
    expect(() => resolveEnvValue("${MISSING}", {})).toThrow(/MISSING/);
  });
});

describe("buildToolRequest — Slack", () => {
  const tool: Tool = {
    name: "notify_support",
    action: "slack_post_message",
    token: "${SLACK_BOT_TOKEN}",
    channel: "#support",
    text: "New reply: {{ draft.text }}",
  };

  it("targets chat.postMessage with a bearer token and a JSON body, resolving refs", () => {
    const req = buildToolRequest(tool, { "draft.text": "hello" }, { SLACK_BOT_TOKEN: "xoxb-1" });
    expect(req.url).toBe("https://slack.com/api/chat.postMessage");
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe("Bearer xoxb-1");
    expect(JSON.parse(req.body!)).toEqual({ channel: "#support", text: "New reply: hello" });
    // The token is a secret to keep out of fixtures, and never appears in URL/body.
    expect(req.secrets).toContain("xoxb-1");
    expect(req.url).not.toContain("xoxb-1");
    expect(req.body).not.toContain("xoxb-1");
  });
});

describe("buildToolRequest — Gmail", () => {
  const tool: Tool = {
    name: "send_reply",
    action: "gmail_send",
    token: "${GMAIL_TOKEN}",
    to: "customer@example.com",
    subject: "Re: {{ classify.category }}",
    body: "Thanks for reaching out.",
  };

  it("targets messages.send with a base64url MIME body, resolving refs", () => {
    const req = buildToolRequest(tool, { "classify.category": "refund" }, { GMAIL_TOKEN: "ya29" });
    expect(req.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(req.headers.Authorization).toBe("Bearer ya29");
    const raw = (JSON.parse(req.body!) as { raw: string }).raw;
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("To: customer@example.com");
    expect(mime).toContain("Subject: Re: refund");
    expect(mime).toContain("Thanks for reaching out.");
  });
});

describe("callHttpTool with a connector", () => {
  it("sends the auth header and body, and extracts the configured field", async () => {
    let captured: { url: string; init: RequestInit | undefined } | undefined;
    const fetchImpl: ToolFetchImpl = async (input, init) => {
      captured = { url: String(input), init };
      return new Response(JSON.stringify({ ok: true, ts: "1" }), { status: 200 });
    };
    const tool: Tool = {
      name: "notify",
      action: "slack_post_message",
      token: "${SLACK_BOT_TOKEN}",
      channel: "#c",
      text: "hi {{ input }}",
      extract: "ok",
    };

    const result = await callHttpTool(
      tool,
      { input: "there" },
      { fetchImpl, env: { SLACK_BOT_TOKEN: "xoxb-9" } },
    );

    expect(result).toBe(true); // extract: "ok"
    expect(captured?.url).toBe("https://slack.com/api/chat.postMessage");
    expect((captured?.init?.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-9");
    expect(JSON.parse(captured?.init?.body as string)).toEqual({ channel: "#c", text: "hi there" });
  });

  it("fails loudly when the connector token env var is unset", async () => {
    const tool: Tool = {
      name: "notify",
      action: "slack_post_message",
      token: "${SLACK_BOT_TOKEN}",
      channel: "#c",
      text: "hi",
    };
    await expect(callHttpTool(tool, {}, { env: {} })).rejects.toThrow(/SLACK_BOT_TOKEN/);
  });
});
