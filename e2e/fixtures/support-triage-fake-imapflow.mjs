// An offline stand-in for `imapflow`, for the support-triage tests (KAM-126). A loader hook
// (support-triage-imap-loader.mjs) makes `import "imapflow"` resolve here, so the real kampong/gmail-imap
// module runs unchanged against a scripted mailbox: in the engine's process, in a `kampong run` child, and in an
// exported project alike. Nothing opens a socket.
//
// KAMPONG_FAKE_IMAP names a JSON file: { "user": "...", "messages": [{ uid, from: { name, address }, subject,
// text, messageId, references?, seen }] }. KAMPONG_FAKE_IMAP_LOG names a file that receives the list of
// operations the module performed, rewritten after each one, so a test can compare what two runs did.
import { readFileSync, writeFileSync } from "node:fs";

const scenario = JSON.parse(readFileSync(process.env.KAMPONG_FAKE_IMAP, "utf8"));
const messages = structuredClone(scenario.messages);
const ops = [];
let appended = 0;

// Written after every operation, not at exit, so a process that is killed (a restart test) still leaves its log.
const log = {
  push(entry) {
    ops.push(entry);
    if (process.env.KAMPONG_FAKE_IMAP_LOG) {
      writeFileSync(process.env.KAMPONG_FAKE_IMAP_LOG, JSON.stringify(ops, null, 2));
    }
  },
};

const address = (a) => (a.name ? `${a.name} <${a.address}>` : a.address);

function source(m) {
  return [
    `From: ${address(m.from)}`,
    `To: ${scenario.user}`,
    `Subject: ${m.subject}`,
    "Date: Mon, 12 Oct 2026 09:00:00 +0000",
    `Message-ID: ${m.messageId}`,
    ...(m.references ? [`References: ${m.references.join(" ")}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    m.text,
    "",
  ].join("\r\n");
}

// The draft's Date and Message-ID differ on every run; everything else must match between two runs.
const normalise = (raw) =>
  raw
    .replace(/^Date: .*$/m, "Date: <date>")
    .replace(/^Message-ID: .*$/m, "Message-ID: <generated>");

const find = (uid) => messages.find((m) => m.uid === Number(uid));

export class ImapFlow {
  constructor(options) {
    this.options = options;
  }
  async connect() {
    if (!this.options.auth?.pass) throw new Error("fake imap: no password was given");
    log.push({
      op: "connect",
      host: this.options.host,
      port: this.options.port,
      user: this.options.auth.user,
    });
  }
  async getMailboxLock(path, options) {
    log.push({ op: "lock", path, readOnly: Boolean(options?.readOnly) });
    return { release() {} };
  }
  async search(query) {
    log.push({ op: "search", query });
    return messages.filter((m) => !m.seen).map((m) => m.uid);
  }
  async *fetch(uids) {
    log.push({ op: "fetch-envelopes", uids });
    for (const uid of uids) {
      const m = find(uid);
      yield {
        uid: m.uid,
        envelope: {
          subject: m.subject,
          messageId: m.messageId,
          from: [m.from],
          date: new Date("2026-10-12T09:00:00Z"),
        },
        internalDate: new Date("2026-10-12T09:00:00Z"),
      };
    }
  }
  async fetchOne(uid) {
    log.push({ op: "fetch-source", uid: Number(uid) });
    const m = find(uid);
    return m ? { uid: m.uid, source: Buffer.from(source(m)) } : false;
  }
  async list() {
    return [{ path: "INBOX" }, { path: "[Gmail]/Drafts", specialUse: "\\Drafts" }];
  }
  async append(path, raw, flags) {
    appended += 1;
    log.push({ op: "append", path, flags, raw: normalise(String(raw)) });
    return { destination: path, uid: 100 + appended };
  }
  async messageFlagsAdd(uid, flags) {
    log.push({ op: "flags", uid, flags });
    const m = find(uid);
    if (m && flags.includes("\\Seen")) m.seen = true;
    return true;
  }
  async logout() {}
  close() {}
}
