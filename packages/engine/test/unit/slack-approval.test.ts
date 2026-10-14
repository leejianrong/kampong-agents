import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildApprovalBlocks,
  postApprovalRequest,
  postInteractionUpdate,
  verifySlackSignature,
  recoverSlackRawBody,
  parseSlackInteractionPayload,
  isApproveAction,
  isRejectAction,
  SlackApiError,
} from "../../src/slack-approval.js";

// KAN-1432 (ADR-0021 Slice D): headless-approval notifications over Slack.
// Pure-function/fake-fetch coverage here; the real Fastify-route wiring
// (signature-verified /slack/interactions callback resolving a run) is
// covered end to end in packages/cli/test/integration/serve.test.ts.

describe("buildApprovalBlocks", () => {
  it("embeds the run id in both button values and labels Approve/Reject", () => {
    const blocks = buildApprovalBlocks("run-1", "Approve this?") as Array<{
      type: string;
      elements?: { action_id: string; value: string }[];
    }>;
    const actions = blocks.find((b) => b.type === "actions")!;
    const values = actions.elements!.map((el) => JSON.parse(el.value));
    expect(values).toEqual([{ runId: "run-1" }, { runId: "run-1" }]);
    const actionIds = actions.elements!.map((el) => el.action_id);
    expect(isApproveAction(actionIds[0]!)).toBe(true);
    expect(isRejectAction(actionIds[1]!)).toBe(true);
  });
});

describe("postApprovalRequest", () => {
  it("posts to chat.postMessage with a bearer token and returns channel/ts", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, channel: "C1", ts: "123.456" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await postApprovalRequest(
      { token: "xoxb-test", channel: "#approvals", runId: "run-1", text: "Approve?" },
      fetchImpl,
    );

    expect(result).toEqual({ channel: "C1", ts: "123.456" });
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-test");
    const body = JSON.parse(init.body as string);
    expect(body.channel).toBe("#approvals");
  });

  it("throws SlackApiError when Slack reports ok: false", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      postApprovalRequest(
        { token: "xoxb-test", channel: "#nope", runId: "run-1", text: "x" },
        fetchImpl,
      ),
    ).rejects.toThrow(SlackApiError);
  });
});

describe("postInteractionUpdate", () => {
  it("posts replace_original: true to the given response_url", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    await postInteractionUpdate("https://hooks.slack.test/abc", "Approved", fetchImpl);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://hooks.slack.test/abc");
    expect(JSON.parse(init.body as string)).toEqual({ replace_original: true, text: "Approved" });
  });
});

function sign(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

describe("verifySlackSignature", () => {
  const secret = "test-signing-secret";
  const rawBody = "payload=%7B%22ok%22%3Atrue%7D";
  const nowSeconds = 1_700_000_000;

  it("accepts a correctly signed, fresh request", () => {
    const timestamp = String(nowSeconds);
    const signature = sign(secret, timestamp, rawBody);
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp,
        rawBody,
        signature,
        now: () => nowSeconds * 1000,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const timestamp = String(nowSeconds);
    const signature = sign(secret, timestamp, rawBody);
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp,
        rawBody: `${rawBody}x`,
        signature,
        now: () => nowSeconds * 1000,
      }),
    ).toBe(false);
  });

  it("rejects the wrong signing secret", () => {
    const timestamp = String(nowSeconds);
    const signature = sign("other-secret", timestamp, rawBody);
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp,
        rawBody,
        signature,
        now: () => nowSeconds * 1000,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp (replay protection)", () => {
    const timestamp = String(nowSeconds - 10 * 60); // 10 minutes old
    const signature = sign(secret, timestamp, rawBody);
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp,
        rawBody,
        signature,
        now: () => nowSeconds * 1000,
      }),
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp: "not-a-number",
        rawBody,
        signature: "v0=whatever",
      }),
    ).toBe(false);
  });
});

describe("parseSlackInteractionPayload", () => {
  function encode(payload: unknown): string {
    return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  }

  it("extracts action id, run id, response_url, and username from a valid interaction", () => {
    const raw = encode({
      actions: [{ action_id: "kampong_approve", value: JSON.stringify({ runId: "run-42" }) }],
      response_url: "https://hooks.slack.test/xyz",
      user: { username: "jian" },
    });
    expect(parseSlackInteractionPayload(raw)).toEqual({
      actionId: "kampong_approve",
      runId: "run-42",
      responseUrl: "https://hooks.slack.test/xyz",
      userName: "jian",
    });
  });

  it("falls back to user.name when username is absent", () => {
    const raw = encode({
      actions: [{ action_id: "kampong_reject", value: JSON.stringify({ runId: "run-1" }) }],
      response_url: "https://hooks.slack.test/xyz",
      user: { name: "Jian Rong" },
    });
    expect(parseSlackInteractionPayload(raw)?.userName).toBe("Jian Rong");
  });

  it("returns undefined when there is no payload field", () => {
    expect(parseSlackInteractionPayload("not=slack")).toBeUndefined();
  });

  it("returns undefined for malformed JSON in payload", () => {
    expect(parseSlackInteractionPayload("payload=not-json")).toBeUndefined();
  });

  it("returns undefined when the action's value has no runId", () => {
    const raw = encode({
      actions: [{ action_id: "kampong_approve", value: JSON.stringify({ foo: "bar" }) }],
      response_url: "https://hooks.slack.test/xyz",
    });
    expect(parseSlackInteractionPayload(raw)).toBeUndefined();
  });

  it("returns undefined when response_url is missing", () => {
    const raw = encode({
      actions: [{ action_id: "kampong_approve", value: JSON.stringify({ runId: "run-1" }) }],
    });
    expect(parseSlackInteractionPayload(raw)).toBeUndefined();
  });
});

describe("recoverSlackRawBody (KAM-124)", () => {
  const secret = "signing-secret";
  const sign = (timestamp: string, body: string) =>
    `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  // Slack encodes the payload like this: RFC 3986 strict, spaces as "+".
  const slackEncode = (text: string) =>
    "payload=" +
    encodeURIComponent(text)
      .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/%20/g, "+");
  const PAYLOAD = JSON.stringify({
    type: "block_actions",
    user: { username: "ana cruz (ops)" },
    actions: [{ action_id: "kampong_approve", value: '{"runId":"r~1!"}' }],
    note: "100% sure, it's fine*",
  });

  it("returns a string body as it arrived", () => {
    expect(recoverSlackRawBody("payload=abc")).toBe("payload=abc");
  });

  it("rebuilds the exact signed bytes from a relayed { payload } body, so the signature verifies", () => {
    const signed = slackEncode(PAYLOAD);
    const timestamp = "1700000000";
    const recovered = recoverSlackRawBody({ payload: PAYLOAD });
    expect(recovered).toBe(signed);
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp,
        rawBody: recovered,
        signature: sign(timestamp, signed),
        now: () => 1700000000_000,
      }),
    ).toBe(true);
  });

  it("does not make a forged or altered click verify", () => {
    const timestamp = "1700000000";
    const signature = sign(timestamp, slackEncode(PAYLOAD));
    const altered = recoverSlackRawBody({ payload: PAYLOAD.replace("approve", "reject") });
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp,
        rawBody: altered,
        signature,
        now: () => 1700000000_000,
      }),
    ).toBe(false);
  });

  it("returns an empty body (which never verifies) for anything that is not a payload", () => {
    for (const body of [undefined, null, 5, {}, { payload: 3 }, []]) {
      expect(recoverSlackRawBody(body)).toBe("");
    }
  });
});
