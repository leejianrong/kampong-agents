import { describe, expect, it } from "vitest";
import { buildToolFromForm } from "../../src/tool-form.js";

describe("buildToolFromForm", () => {
  it("builds a valid tool spec fragment from structured input alone, no LLM call involved", () => {
    const result = buildToolFromForm({
      name: "check_inventory",
      method: "GET",
      url: "https://api.store.com/stock",
      extract: "quantity",
    });

    expect(result.success).toBe(true);
    expect(result.tool).toEqual({
      name: "check_inventory",
      action: "http_request",
      method: "GET",
      url: "https://api.store.com/stock",
      extract: "quantity",
    });
  });

  it("rejects an invalid HTTP method", () => {
    const result = buildToolFromForm({ name: "x", method: "FETCH", url: "https://example.com" });

    expect(result.success).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it("rejects a missing name", () => {
    const result = buildToolFromForm({ name: "", method: "GET", url: "https://example.com" });

    expect(result.success).toBe(false);
  });

  // KAN-1430 (ADR-0021): the Slack/Gmail connector shapes.
  it("builds a Slack connector tool", () => {
    const result = buildToolFromForm({
      kind: "slack_post_message",
      name: "notify_support",
      token: "${SLACK_BOT_TOKEN}",
      channel: "#support",
      text: "{{ draft.text }}",
    });

    expect(result.success).toBe(true);
    expect(result.tool).toEqual({
      name: "notify_support",
      action: "slack_post_message",
      token: "${SLACK_BOT_TOKEN}",
      channel: "#support",
      text: "{{ draft.text }}",
    });
  });

  it("builds a Gmail connector tool", () => {
    const result = buildToolFromForm({
      kind: "gmail_send",
      name: "send_reply",
      token: "${GMAIL_TOKEN}",
      to: "c@example.com",
      subject: "Re: your ticket",
      body: "{{ draft.text }}",
    });

    expect(result.success).toBe(true);
    expect(result.tool).toMatchObject({ action: "gmail_send", to: "c@example.com" });
  });

  it("rejects a connector whose token is a literal, not an ${ENV} placeholder", () => {
    const result = buildToolFromForm({
      kind: "slack_post_message",
      name: "notify",
      token: "xoxb-real-secret",
      channel: "#c",
      text: "hi",
    });

    expect(result.success).toBe(false);
  });
});
