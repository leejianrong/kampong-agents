import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogEntryFromManifest, planOpForm } from "@kampong/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invokeOp, type InvokeOpOptions } from "../../src/component.js";
import { createFirstPartyRegistry } from "../../src/component-registry.js";
import { ToolCallError, type ToolFetchImpl } from "../../src/http-tool.js";
import { createFixtureFetch } from "../../src/tool-fixtures.js";

// KAM-123: kampong/slack@1.1.0 against a fake Slack. Nothing here reaches the network.

const registry = createFirstPartyRegistry();
const noSleep = { now: () => 0, sleep: async () => {} };
const ENV = { SLACK_BOT_TOKEN: "xoxb-test-token" };

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function fake(route: (seen: Seen, n: number) => Response): {
  fetchImpl: ToolFetchImpl;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetchImpl: async (url, init) => {
      const entry: Seen = {
        url: String(url),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
        ...(typeof init?.body === "string" && { body: JSON.parse(init.body) }),
      };
      seen.push(entry);
      return route(entry, seen.length);
    },
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function slack(
  op: string,
  input: Record<string, unknown>,
  fetchImpl: ToolFetchImpl,
  extra: Partial<InvokeOpOptions> = {},
): Promise<unknown> {
  const { manifest } = await registry.resolve("kampong/slack", "1.1.0");
  return invokeOp(manifest, op, input, {
    fetchImpl,
    clock: noSleep,
    pacer: { wait: async () => {} },
    env: ENV,
    ...extra,
  });
}

const OK = { ok: true, channel: "C123", ts: "1700000000.000100" };
const BUTTONS = [
  { type: "section", text: { type: "mrkdwn", text: "Send this reply?" } },
  {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Approve" },
        action_id: "approve",
        value: "r1",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Reject" },
        action_id: "reject",
        value: "r1",
      },
    ],
  },
];

describe("kampong/slack@1.1.0", () => {
  it("keeps 1.0.0 as it was and adds the new ops beside it", async () => {
    const old = (await registry.resolve("kampong/slack", "1.0.0")).manifest;
    expect(Object.keys(old.ops)).toEqual(["auth_test", "post_message"]);
    const next = (await registry.resolve("kampong/slack", "1.1.0")).manifest;
    expect(Object.keys(next.ops)).toEqual([
      "auth_test",
      "post_message",
      "reply_in_thread",
      "update_message",
      "post_blocks",
      "update_blocks",
      "add_reaction",
    ]);
    expect(next.permissions?.egress).toEqual(["slack.com"]);
  });

  it("post_message sends only what was given, with the token in a header", async () => {
    const { fetchImpl, seen } = fake(() => json(OK));
    expect(await slack("post_message", { channel: "#support", text: "hi" }, fetchImpl)).toEqual(OK);
    expect(seen[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(seen[0]!.body).toEqual({ channel: "#support", text: "hi" });
    expect(seen[0]!.headers.Authorization).toBe("Bearer xoxb-test-token");

    await slack("post_message", { channel: "#support", text: "hi", thread_ts: "1.2" }, fetchImpl);
    expect(seen[1]!.body).toEqual({ channel: "#support", text: "hi", thread_ts: "1.2" });
  });

  it("post_blocks posts Block Kit blocks with buttons, unescaped, plus the fallback text", async () => {
    const { fetchImpl, seen } = fake(() => json(OK));
    await slack("post_blocks", { channel: "C123", text: "Approve?", blocks: BUTTONS }, fetchImpl);
    expect(seen[0]!.body).toEqual({ channel: "C123", text: "Approve?", blocks: BUTTONS });
  });

  it("reply_in_thread posts under the thread and can broadcast", async () => {
    const { fetchImpl, seen } = fake(() => json(OK));
    await slack("reply_in_thread", { channel: "C123", thread_ts: "1.2", text: "done" }, fetchImpl);
    expect(seen[0]!.body).toEqual({ channel: "C123", thread_ts: "1.2", text: "done" });
    await slack(
      "reply_in_thread",
      { channel: "C123", thread_ts: "1.2", text: "done", broadcast: true },
      fetchImpl,
    );
    expect(seen[1]!.body).toMatchObject({ reply_broadcast: true });
  });

  it("update_message and update_blocks call chat.update; blocks: [] removes the buttons", async () => {
    const { fetchImpl, seen } = fake(() => json(OK));
    await slack("update_message", { channel: "C123", ts: "1.2", text: "Approved" }, fetchImpl);
    expect(seen[0]!.url).toBe("https://slack.com/api/chat.update");
    expect(seen[0]!.body).toEqual({ channel: "C123", ts: "1.2", text: "Approved" });
    await slack("update_blocks", { channel: "C123", ts: "1.2", blocks: [] }, fetchImpl);
    expect(seen[1]!.body).toEqual({ channel: "C123", ts: "1.2", blocks: [] });
  });

  it("add_reaction calls reactions.add", async () => {
    const { fetchImpl, seen } = fake(() => json({ ok: true }));
    await slack(
      "add_reaction",
      { channel: "C123", timestamp: "1.2", name: "white_check_mark" },
      fetchImpl,
    );
    expect(seen[0]!.url).toBe("https://slack.com/api/reactions.add");
    expect(seen[0]!.body).toEqual({ channel: "C123", timestamp: "1.2", name: "white_check_mark" });
  });

  it("reports a 200 { ok: false } as a failure naming Slack's error, for every write op", async () => {
    const { fetchImpl } = fake(() => json({ ok: false, error: "channel_not_found" }));
    const calls: [string, Record<string, unknown>][] = [
      ["post_message", { channel: "#x", text: "t" }],
      ["post_blocks", { channel: "#x", text: "t", blocks: [] }],
      ["reply_in_thread", { channel: "C", thread_ts: "1", text: "t" }],
      ["update_message", { channel: "C", ts: "1", text: "t" }],
      ["update_blocks", { channel: "C", ts: "1", blocks: [] }],
      ["add_reaction", { channel: "C", timestamp: "1", name: "x" }],
    ];
    for (const [op, input] of calls) {
      await expect(slack(op, input, fetchImpl), op).rejects.toThrow(/channel_not_found/);
    }
  });

  it("retries a ratelimited answer and then succeeds, but never retries another error", async () => {
    const limited = fake((_s, n) => (n < 3 ? json({ ok: false, error: "ratelimited" }) : json(OK)));
    expect(await slack("post_message", { channel: "C", text: "t" }, limited.fetchImpl)).toEqual(OK);
    expect(limited.seen).toHaveLength(3);

    const refused = fake(() => json({ ok: false, error: "not_in_channel" }));
    await expect(
      slack("post_message", { channel: "C", text: "t" }, refused.fetchImpl),
    ).rejects.toBeInstanceOf(ToolCallError);
    expect(refused.seen).toHaveLength(1);
  });

  it("refuses to send the token anywhere but slack.com", async () => {
    const { manifest } = await registry.resolve("kampong/slack", "1.1.0");
    for (const op of Object.values(manifest.ops)) {
      expect((op as { request: { url: string } }).request.url).toMatch(/^https:\/\/slack\.com\//);
    }
  });

  describe("recorded fixtures", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "kampong-slack-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("record then replay returns the same answer, and a recorded failure replays as a failure", async () => {
      const server = fake((s) =>
        s.body?.channel === "#missing" ? json({ ok: false, error: "channel_not_found" }) : json(OK),
      );
      const record = createFixtureFetch({
        mode: "record",
        fixturesDir: dir,
        fetchImpl: server.fetchImpl,
      });
      const replay = createFixtureFetch({ mode: "replay", fixturesDir: dir });
      const input = { channel: "C123", text: "Approve?", blocks: BUTTONS };
      const recorded = await slack("post_blocks", input, record);
      expect(await slack("post_blocks", input, replay)).toEqual(recorded);
      expect(JSON.stringify(await readBack(dir))).not.toContain("xoxb-test-token");

      await expect(
        slack("post_message", { channel: "#missing", text: "t" }, record),
      ).rejects.toThrow(/channel_not_found/);
      await expect(
        slack("post_message", { channel: "#missing", text: "t" }, replay),
      ).rejects.toThrow(/channel_not_found/);
    });
  });

  it("gets generated canvas forms: plain ops as fields, block ops falling back to YAML and naming blocks", async () => {
    const { manifest, digest } = await registry.resolve("kampong/slack", "1.1.0");
    const ops = catalogEntryFromManifest(manifest, digest).ops;
    expect(planOpForm(ops.post_message!.input).fields.map((f) => [f.name, f.required])).toEqual([
      ["channel", true],
      ["text", true],
      ["thread_ts", false],
    ]);
    for (const op of ["reply_in_thread", "update_message", "add_reaction"]) {
      expect(planOpForm(ops[op]!.input).supported, op).toBe(true);
    }
    for (const op of ["post_blocks", "update_blocks"]) {
      const plan = planOpForm(ops[op]!.input);
      expect(plan.supported, op).toBe(false);
      expect(plan.reason, op).toContain("blocks");
    }
  });
});

async function readBack(dir: string): Promise<unknown[]> {
  const { readdirSync, readFileSync } = await import("node:fs");
  return readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8"));
}
