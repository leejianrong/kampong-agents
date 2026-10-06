import { describe, expect, it } from "vitest";
import { buildToolFromForm, parseKeyValueLines } from "../../src/tool-form.js";

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

// KAN-1845: headers, query, body and response mode on the HTTP form.
describe("buildToolFromForm -- http_request request fields (KAN-1845)", () => {
  const base = { name: "call", method: "POST", url: "https://api.example.test/x" };

  it("builds a tool with headers, query, a json body and a response mode", () => {
    const result = buildToolFromForm({
      ...base,
      headers: { Authorization: "Bearer ${API_TOKEN}" },
      query: { symbol: "IBM" },
      body: { json: { a: 1 } },
      response: { mode: "text" },
    });

    expect(result.errors).toBeUndefined();
    expect(result.tool).toMatchObject({
      action: "http_request",
      headers: { Authorization: "Bearer ${API_TOKEN}" },
      query: { symbol: "IBM" },
      body: { json: { a: 1 } },
      response: { mode: "text" },
    });
  });

  it("omits the new fields entirely when they are empty, so existing specs serialise unchanged", () => {
    const result = buildToolFromForm({ ...base, headers: {}, query: {} });

    expect(result.tool).toEqual({
      name: "call",
      action: "http_request",
      method: "POST",
      url: "https://api.example.test/x",
    });
  });

  it("rejects a literal credential in a header", () => {
    const result = buildToolFromForm({ ...base, headers: { Authorization: "Bearer literal" } });

    expect(result.success).toBe(false);
    expect(result.errors?.join(" ")).toMatch(/credential/);
  });
});

describe("parseKeyValueLines", () => {
  it("parses one name/value pair per line, ignoring blank lines and trimming", () => {
    expect(parseKeyValueLines("Accept: application/json\n\n  X-Trace :  abc  ", ":")).toEqual({
      values: { Accept: "application/json", "X-Trace": "abc" },
      errors: [],
    });
  });

  it("splits on the first separator only, so a value may contain it", () => {
    expect(parseKeyValueLines("url=https://a.test/?x=1", "=").values).toEqual({
      url: "https://a.test/?x=1",
    });
  });

  it("reports the line number of a line with no separator or no name", () => {
    const result = parseKeyValueLines("ok: 1\nnonsense\n: novalue", ":");

    expect(result.errors).toEqual([
      'line 2: expected "name:value"',
      'line 3: expected "name:value"',
    ]);
  });
});
