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

// KAM-193: a tool's name and URL are checked at the form, and an empty field is named. `my tool!` and `not a url`
// used to save, and two empty fields gave the same schema sentence twice.
describe("buildToolFromForm: named, checked fields (KAM-193)", () => {
  const http = (over: Record<string, unknown>) =>
    buildToolFromForm({
      name: "fetch_price",
      method: "GET",
      url: "https://api.example.com/q",
      ...over,
    });

  it.each(["my tool!", "my tool", "1tool", "tool-name", "tool.name", "é"])(
    "rejects the name %j, in words, against the name field",
    (name) => {
      const result = http({ name });
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.["name"]).toMatch(/^Name .*letters, digits and underscores/);
      expect(result.errors).toEqual([result.fieldErrors?.["name"]]);
    },
  );

  it.each(["fetch_price", "_x", "A1", "get_2"])("accepts the name %j", (name) => {
    expect(http({ name }).success).toBe(true);
  });

  it.each([
    ["not a url", /URL .*start with http:\/\/ or https:\/\//],
    ["example.com/x", /URL .*start with http:\/\/ or https:\/\//],
    ["ftp://example.com/x", /URL .*start with http:\/\/ or https:\/\//],
    ["https://", /URL .*not a web address/],
    ["https://exa mple.com", /URL .*spaces/],
  ])("rejects the URL %j, against the url field", (url, message) => {
    const result = http({ url });
    expect(result.success).toBe(false);
    expect(result.fieldErrors?.["url"]).toMatch(message);
  });

  it.each([
    "https://api.example.com/q",
    "http://localhost:8080/x?y=1",
    "https://api.example.com/{symbol}/daily",
    "https://api.example.com/q?key=${API_KEY}",
    "{{ vars.base }}/v1/items",
    "${BASE_URL}/v1/items",
    "https://{{ vars.host }}/x",
  ])("accepts the URL %j, placeholders included", (url) => {
    expect(http({ url }).success).toBe(true);
  });

  it("names each empty field once instead of repeating the schema's sentence", () => {
    const result = buildToolFromForm({ name: "", method: "GET", url: "" });
    expect(result.success).toBe(false);
    expect(result.fieldErrors).toEqual({ name: "Name is required.", url: "URL is required." });
    expect(result.errors).toEqual(["Name is required.", "URL is required."]);
    expect(result.errors?.join(" ")).not.toContain("Too small");
  });

  it("names the empty fields of a Slack and a Gmail tool", () => {
    const slack = buildToolFromForm({
      kind: "slack_post_message",
      name: "post",
      token: "",
      channel: "",
      text: "",
    });
    expect(slack.fieldErrors).toEqual({
      token: "Token is required.",
      channel: "Channel is required.",
      text: "Text is required.",
    });
    const gmail = buildToolFromForm({
      kind: "gmail_send",
      name: "mail",
      token: "${GMAIL_TOKEN}",
      to: "",
      subject: "",
      body: "",
    });
    expect(gmail.fieldErrors).toEqual({
      to: "To is required.",
      subject: "Subject is required.",
      body: "Body is required.",
    });
  });

  it("keeps the schema's own messages for what only it knows, against the field", () => {
    const result = buildToolFromForm({
      kind: "slack_post_message",
      name: "post",
      token: "xoxb-literal",
      channel: "#a",
      text: "hi",
    });
    expect(result.success).toBe(false);
    expect(result.fieldErrors?.["token"]).toBeTruthy();
    expect(result.fieldErrors?.["token"]).not.toMatch(/Too small/);
  });
});
