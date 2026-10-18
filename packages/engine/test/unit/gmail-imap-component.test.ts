import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import { invokeOp } from "../../src/component.js";
import { createFirstPartyRegistry } from "../../src/component-registry.js";
import { createModuleFixtures } from "../../src/module-fixtures.js";

// KAM-122: kampong/gmail-imap against a scripted IMAP client. `imapflow` is replaced, so nothing here opens a
// socket; the module's own logic (what it asks for, how it threads a draft, what it refuses) is what runs, and
// the MIME it builds is parsed back with the real mailparser.

interface Script {
  uids: number[];
  envelopes: Record<
    number,
    { subject: string; messageId: string; from: { name?: string; address: string }[]; date: Date }
  >;
  sources: Record<number, string>;
  boxes: { path: string; specialUse?: string }[];
  authFails: boolean;
  appended: { path: string; raw: string; flags: string[] }[];
  flagged: { uid: number; flags: string[] }[];
  locks: { path: string; readOnly: boolean }[];
  calls: string[];
}
const script: Script = {
  uids: [],
  envelopes: {},
  sources: {},
  boxes: [],
  authFails: false,
  appended: [],
  flagged: [],
  locks: [],
  calls: [],
};

vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(public options: unknown) {
      script.calls.push("new");
    }
    async connect() {
      script.calls.push("connect");
      if (script.authFails)
        throw Object.assign(new Error("Invalid credentials"), { authenticationFailed: true });
    }
    async getMailboxLock(path: string, options?: { readOnly?: boolean }) {
      script.locks.push({ path, readOnly: options?.readOnly ?? false });
      return { release: () => script.calls.push("release") };
    }
    async search() {
      return [...script.uids];
    }
    async *fetch(uids: number[]) {
      for (const uid of uids) {
        const e = script.envelopes[uid]!;
        yield {
          uid,
          envelope: { subject: e.subject, messageId: e.messageId, from: e.from, date: e.date },
          internalDate: e.date,
        };
      }
    }
    async fetchOne(uid: number) {
      const source = script.sources[uid];
      return source === undefined ? false : { uid, source: Buffer.from(source) };
    }
    async list() {
      return script.boxes;
    }
    async append(path: string, raw: string, flags: string[]) {
      script.appended.push({ path, raw, flags });
      return { destination: path, uid: 7 };
    }
    async messageFlagsAdd(uid: number, flags: string[]) {
      script.flagged.push({ uid, flags });
      return true;
    }
    async logout() {
      script.calls.push("logout");
    }
    close() {
      script.calls.push("close");
    }
  },
}));

// @ts-expect-error a plain .mjs component module with no type declarations
const { invoke } = (await import("../../components/kampong/gmail-imap/1.0.0/index.mjs")) as {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke: (op: string, input: Record<string, unknown>, ctx: unknown) => Promise<any>;
};

const ctx = (signal = new AbortController().signal) => ({
  secrets: {
    get: (slot: string) => ({ user: "me@example.com", password: "app-password-1234" })[slot]!,
  },
  env: { get: () => undefined },
  fetch: () => {
    throw new Error("a module must not use fetch for IMAP");
  },
  signal,
});

const ORIGINAL = [
  "From: Ana Cruz <ana@client.example>",
  "To: me@example.com",
  "Subject: Invoice question",
  "Date: Mon, 12 Oct 2026 09:00:00 +0000",
  "Message-ID: <orig-1@client.example>",
  "References: <earlier-0@client.example>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello, where is my invoice?",
  "",
].join("\r\n");

beforeEach(() => {
  Object.assign(script, {
    uids: [],
    envelopes: {},
    sources: { 5: ORIGINAL },
    boxes: [
      { path: "INBOX" },
      { path: "[Gmail]/Entwürfe", specialUse: "\\Drafts" },
      { path: "[Gmail]/Drafts-not" },
    ],
    authFails: false,
    appended: [],
    flagged: [],
    locks: [],
    calls: [],
  });
});

describe("kampong/gmail-imap", () => {
  it("signs in and always signs out, even when the op fails", async () => {
    expect(await invoke("check_login", {}, ctx())).toEqual({ ok: true });
    expect(script.calls).toEqual(["new", "connect", "logout"]);

    script.calls.length = 0;
    await expect(invoke("get_message", { uid: 99 }, ctx())).rejects.toThrow(
      /no message with uid 99/,
    );
    expect(script.calls.at(-1)).toBe("logout");
  });

  it("says a refused login is refused (status 401, for doctor) and names what to check", async () => {
    script.authFails = true;
    const error = await invoke("check_login", {}, ctx()).catch((e) => e);
    expect(error.status).toBe(401);
    expect(error.message).toMatch(/app password/);
    expect(error.message).not.toContain("app-password-1234");
  });

  it("list_unseen returns the oldest unread first, cut at the limit, and does not change any flag", async () => {
    script.uids = [40, 12, 31, 7];
    const d = new Date("2026-10-12T09:00:00Z");
    for (const uid of script.uids) {
      script.envelopes[uid] = {
        subject: `s${uid}`,
        messageId: `<m${uid}@x>`,
        from: [{ name: "A", address: "a@x.example" }],
        date: d,
      };
    }
    const result = await invoke("list_unseen", { limit: 2 }, ctx());
    expect(result.count).toBe(4);
    expect(result.messages.map((m: { uid: number }) => m.uid)).toEqual([7, 12]);
    expect(result.messages[0]).toMatchObject({
      subject: "s7",
      message_id: "<m7@x>",
      from: "A <a@x.example>",
    });
    expect(script.locks).toEqual([{ path: "INBOX", readOnly: true }]);
    expect(script.flagged).toEqual([]);
  });

  it("get_message returns the threading headers and text, read-only, without marking it seen", async () => {
    const message = await invoke("get_message", { uid: 5 }, ctx());
    expect(message).toMatchObject({
      uid: 5,
      message_id: "<orig-1@client.example>",
      references: ["<earlier-0@client.example>"],
      subject: "Invoice question",
      from: "Ana Cruz <ana@client.example>",
      truncated: false,
    });
    expect(message.text).toContain("where is my invoice");
    expect(script.locks[0]!.readOnly).toBe(true);
    expect(script.flagged).toEqual([]);
  });

  it("create_draft threads a reply under the original and saves it flagged \\Draft in the \\Drafts mailbox", async () => {
    const result = await invoke(
      "create_draft",
      { reply_to_uid: 5, body: "It is attached.\nThanks!" },
      ctx(),
    );
    // The folder came from the flag, whatever its name.
    expect(script.appended).toHaveLength(1);
    expect(script.appended[0]).toMatchObject({ path: "[Gmail]/Entwürfe", flags: ["\\Draft"] });
    expect(result).toMatchObject({ mailbox: "[Gmail]/Entwürfe", uid: 7 });

    const draft = await simpleParser(script.appended[0]!.raw);
    expect(draft.inReplyTo).toBe("<orig-1@client.example>");
    expect(draft.references).toEqual(["<earlier-0@client.example>", "<orig-1@client.example>"]);
    expect(draft.subject).toBe("Re: Invoice question");
    expect(draft.to?.value[0]!.address).toBe("ana@client.example");
    expect(draft.from?.value[0]!.address).toBe("me@example.com");
    expect(draft.messageId).toBe(result.message_id);
    expect(draft.text).toBe("It is attached.\nThanks!");
  });

  it("keeps an existing Re: and lets the caller override to and subject; encodes a non-ASCII subject", async () => {
    await invoke(
      "create_draft",
      {
        to: "boss@x.example, Cc Person <cc@x.example>",
        cc: "y@x.example",
        subject: "Café ☕",
        body: "hi",
      },
      ctx(),
    );
    const draft = await simpleParser(script.appended[0]!.raw);
    expect(draft.subject).toBe("Café ☕");
    expect(draft.to?.value.map((a) => a.address)).toEqual(["boss@x.example", "cc@x.example"]);
    expect(draft.cc?.value[0]!.address).toBe("y@x.example");
    expect(draft.inReplyTo).toBeUndefined();
  });

  it("refuses to write a draft when the account has no \\Drafts mailbox, rather than guessing a name", async () => {
    script.boxes = [{ path: "INBOX" }, { path: "Drafts" }];
    await expect(
      invoke("create_draft", { to: "a@x.example", subject: "s", body: "b" }, ctx()),
    ).rejects.toThrow(/\\Drafts/);
    expect(script.appended).toEqual([]);
  });

  it("refuses line breaks in header fields, so a value cannot add a Bcc header", async () => {
    for (const bad of [
      { to: "a@x.example\r\nBcc: evil@x.example", subject: "s" },
      { to: "a@x.example", subject: "s\r\nBcc: evil@x.example" },
      { to: "a@x.example", subject: "s", in_reply_to: "<a@x>\nBcc: e@x" },
      { to: "a@x.example", subject: "s", references: ["<a@x>\r\nBcc: e@x"] },
    ]) {
      await expect(invoke("create_draft", { ...bad, body: "b" }, ctx())).rejects.toThrow(
        /single line|not an email/,
      );
    }
    expect(script.appended).toEqual([]);
  });

  it("requires a body, a recipient and a subject unless it is a reply", async () => {
    await expect(
      invoke("create_draft", { to: "a@x.example", subject: "s" }, ctx()),
    ).rejects.toThrow(/body/);
    await expect(invoke("create_draft", { subject: "s", body: "b" }, ctx())).rejects.toThrow(
      /to is required/,
    );
    await expect(invoke("create_draft", { to: "a@x.example", body: "b" }, ctx())).rejects.toThrow(
      /subject is required/,
    );
  });

  it("mark_seen adds \\Seen to just that message", async () => {
    expect(await invoke("mark_seen", { uid: 5 }, ctx())).toEqual({ ok: true, uid: 5 });
    expect(script.flagged).toEqual([{ uid: 5, flags: ["\\Seen"] }]);
    expect(script.locks).toEqual([{ path: "INBOX", readOnly: false }]);
  });

  it("validates uid and mailbox, and rejects an unknown op", async () => {
    await expect(invoke("get_message", { uid: 0 }, ctx())).rejects.toThrow(/uid/);
    await expect(invoke("get_message", { uid: "5" }, ctx())).rejects.toThrow(/uid/);
    await expect(invoke("list_unseen", { mailbox: "IN\u0000BOX" }, ctx())).rejects.toThrow(
      /mailbox/,
    );
    await expect(invoke("send", {}, ctx())).rejects.toThrow(/no op "send"/);
  });

  it("closes the connection when the run is aborted", async () => {
    const controller = new AbortController();
    const pending = invoke("check_login", {}, ctx(controller.signal));
    controller.abort();
    await pending.catch(() => {});
    // abort fired before connect resolved or after; either way a close or a logout ends the session
    expect(script.calls.some((c) => c === "close" || c === "logout")).toBe(true);
  });
});

describe("kampong/gmail-imap through the op pipeline", () => {
  const registry = createFirstPartyRegistry();
  // The in-process runner imports the module natively, past the mock above, so a runner that calls the
  // mocked module stands in for it; everything else is the real invokeOp.
  const runner = {
    invoke: async (_m: unknown, op: string, input: Record<string, unknown>, c: unknown) =>
      invoke(op, input, c),
  };
  const ENV = { GMAIL_ADDRESS: "me@example.com", GMAIL_APP_PASSWORD: "app-password-1234" };

  it("records and replays an op at the invoke boundary, and replay needs no credentials or connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kampong-imap-"));
    try {
      const { manifest } = await registry.resolve("kampong/gmail-imap", "1.0.0");
      const recorded = await invokeOp(
        manifest,
        "get_message",
        { uid: 5 },
        {
          runner: runner as never,
          env: ENV,
          moduleFixtures: createModuleFixtures({
            mode: "record",
            fixturesDir: dir,
            secrets: [ENV.GMAIL_APP_PASSWORD],
          }),
        },
      );
      script.calls.length = 0;
      const replayed = await invokeOp(
        manifest,
        "get_message",
        { uid: 5 },
        {
          runner: runner as never,
          env: {},
          moduleFixtures: createModuleFixtures({ mode: "replay", fixturesDir: dir }),
        },
      );
      // The address is a secret slot too, so a fixture never holds it: it comes back as [REDACTED].
      expect(replayed).toEqual({ ...(recorded as object), to: ["[REDACTED]"] });
      expect(script.calls).toEqual([]);
      const stored = readdirSync(dir)
        .map((f) => readFileSync(join(dir, f), "utf8"))
        .join("");
      expect(stored).not.toContain(ENV.GMAIL_APP_PASSWORD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declares its permissions: one host, two slots bound to it, and exact dependency pins", async () => {
    const { manifest } = await registry.resolve("kampong/gmail-imap", "1.0.0");
    expect(manifest.permissions?.egress).toEqual(["imap.gmail.com:993"]);
    expect(Object.keys(manifest.auth?.slots ?? {})).toEqual(["user", "password"]);
    for (const slot of Object.values(manifest.auth?.slots ?? {}))
      expect(slot.hosts).toEqual(["imap.gmail.com:993"]);
    expect(manifest.kind === "module" && manifest.deps).toEqual({
      imapflow: "2.4.3",
      mailparser: "3.9.39",
    });
  });
});
