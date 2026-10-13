// kampong/gmail-imap: read a Gmail inbox and write reply drafts over IMAP with an app password (KAM-122).
//
// A module because IMAP is a long-lived, stateful socket protocol, not a request template. It connects to
// imap.gmail.com:993 over TLS with the two declared secret slots (the address and the app password), runs
// one op, and logs out. Nothing is marked read unless you call mark_seen: get_message and list_unseen
// leave the \Seen flag alone, so a run that fails halfway does not lose a message.
//
// The sockets belong to the `imapflow` library, not to `ctx.fetch`, so the egress list in the manifest is
// a declaration a reviewer holds this code to, not something the runtime enforces (ADR-0031 points 3 and 4).
// The host is a constant below and cannot come from input.

import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const HOST = "imap.gmail.com";
const PORT = 993;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_SOURCE_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 50_000;
const ADDRESS = /^[^\s<>,;"@]+@[^\s<>,;"@]+$/;
const NAMED_ADDRESS = /^[^\r\n<>]*<[^\s<>,;"@]+@[^\s<>,;"@]+>$/;

export async function invoke(op, input, ctx) {
  switch (op) {
    case "check_login":
      return withClient(ctx, async () => ({ ok: true }));
    case "list_unseen":
      return withClient(ctx, (client) => listUnseen(client, input));
    case "get_message":
      return withClient(ctx, (client) => getMessage(client, input));
    case "create_draft":
      return withClient(ctx, (client, user) => createDraft(client, user, input));
    case "mark_seen":
      return withClient(ctx, (client) => markSeen(client, input));
    default:
      throw new Error(`kampong/gmail-imap has no op "${op}"`);
  }
}

async function withClient(ctx, fn) {
  const user = ctx.secrets.get("user");
  const client = new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user, pass: ctx.secrets.get("password") },
    logger: false,
  });
  // An aborted run (a timeout, a stopped service) closes the socket instead of leaving it open.
  const onAbort = () => client.close();
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect();
  } catch (error) {
    ctx.signal?.removeEventListener("abort", onAbort);
    throw describeConnectError(error);
  }
  try {
    return await fn(client, user);
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    await client.logout().catch(() => client.close());
  }
}

// `status` lets `kampong doctor` tell a refused login (401) from a service that is unreachable.
function describeConnectError(error) {
  if (error && error.authenticationFailed) {
    return Object.assign(
      new Error(
        "Gmail refused the login: check the address, that IMAP is enabled, and that the password is an app password (not the account password)",
      ),
      { status: 401 },
    );
  }
  return new Error(`could not connect to ${HOST}: ${error?.message ?? error}`);
}

function mailboxOf(input) {
  const name = input.mailbox ?? "INBOX";
  if (typeof name !== "string" || name === "" || [...name].some((ch) => ch.charCodeAt(0) < 32)) {
    throw new Error("mailbox must be a mailbox name without control characters");
  }
  return name;
}

function uidOf(input) {
  const uid = input.uid;
  if (!Number.isInteger(uid) || uid < 1) throw new Error("uid must be a positive integer");
  return uid;
}

function formatAddress(entry) {
  if (!entry) return undefined;
  return entry.name ? `${entry.name} <${entry.address}>` : entry.address;
}

async function listUnseen(client, input) {
  const limit = Math.min(
    Number.isInteger(input.limit) && input.limit > 0 ? input.limit : DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  const lock = await client.getMailboxLock(mailboxOf(input), { readOnly: true });
  try {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    uids.sort((a, b) => a - b);
    const wanted = uids.slice(0, limit);
    const messages = [];
    if (wanted.length > 0) {
      for await (const message of client.fetch(
        wanted,
        { uid: true, envelope: true, internalDate: true },
        { uid: true },
      )) {
        const envelope = message.envelope ?? {};
        messages.push({
          uid: message.uid,
          message_id: envelope.messageId,
          subject: envelope.subject ?? "",
          from: formatAddress(envelope.from?.[0]),
          date: (envelope.date ?? message.internalDate)?.toISOString?.(),
        });
      }
    }
    messages.sort((a, b) => a.uid - b.uid);
    return { count: uids.length, messages };
  } finally {
    lock.release();
  }
}

// Reads and parses one message without touching its flags (imapflow fetches the source with BODY.PEEK).
async function readMessage(client, mailbox, uid) {
  const lock = await client.getMailboxLock(mailbox, { readOnly: true });
  try {
    const fetched = await client.fetchOne(
      String(uid),
      { uid: true, source: { maxLength: MAX_SOURCE_BYTES } },
      { uid: true },
    );
    if (!fetched || !fetched.source) throw new Error(`no message with uid ${uid} in ${mailbox}`);
    return await simpleParser(fetched.source);
  } finally {
    lock.release();
  }
}

const idList = (value) => (Array.isArray(value) ? value : value ? [value] : []);

async function getMessage(client, input) {
  const uid = uidOf(input);
  const mailbox = mailboxOf(input);
  const parsed = await readMessage(client, mailbox, uid);
  const text = parsed.text ?? "";
  return {
    uid,
    mailbox,
    message_id: parsed.messageId,
    in_reply_to: parsed.inReplyTo,
    references: idList(parsed.references),
    subject: parsed.subject ?? "",
    from: formatAddress(parsed.from?.value?.[0]),
    reply_to: formatAddress(parsed.replyTo?.value?.[0]),
    to: (parsed.to?.value ?? []).map(formatAddress),
    cc: (parsed.cc?.value ?? []).map(formatAddress),
    date: parsed.date?.toISOString?.(),
    text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text,
    truncated: text.length > MAX_TEXT_CHARS,
    attachments: (parsed.attachments ?? []).map((a) => a.filename ?? "(unnamed)"),
  };
}

function noLineBreak(field, value) {
  // These land in header lines; a line break would let a value add headers such as Bcc.
  if (typeof value !== "string" || /[\r\n]/.test(value)) {
    throw new Error(`${field} must be a single line of text`);
  }
  return value;
}

function addressList(field, value) {
  const list = (Array.isArray(value) ? value : String(value).split(","))
    .map((entry) => noLineBreak(field, String(entry)).trim())
    .filter((entry) => entry !== "");
  if (list.length === 0) throw new Error(`${field} needs at least one address`);
  for (const entry of list) {
    if (!ADDRESS.test(entry) && !NAMED_ADDRESS.test(entry)) {
      throw new Error(`${field} has an entry that is not an email address`);
    }
  }
  return list.join(", ");
}

const bracketed = (id) => (id.startsWith("<") ? id : `<${id}>`);

// RFC 2047 encoded-word for a header that is not plain ASCII.
function encodeHeader(value) {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function buildMime({ from, to, cc, subject, body, inReplyTo, references, messageId }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references.length > 0 ? [`References: ${references.join(" ")}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    (
      Buffer.from(body, "utf8")
        .toString("base64")
        .match(/.{1,76}/g) ?? []
    ).join("\r\n"),
    "",
  ];
  return lines.join("\r\n");
}

async function createDraft(client, user, input) {
  if (typeof input.body !== "string" || input.body === "") throw new Error("body is required");
  let to = input.to;
  let subject = input.subject;
  let inReplyTo = input.in_reply_to;
  let references = idList(input.references);

  // Replying to a message threads the draft under it: In-Reply-To is its Message-ID, References is its own
  // References plus that id, and the subject and recipient default from it.
  if (input.reply_to_uid !== undefined) {
    const original = await readMessage(
      client,
      mailboxOf(input),
      uidOf({ uid: input.reply_to_uid }),
    );
    if (!original.messageId) throw new Error("the message being replied to has no Message-ID");
    inReplyTo = original.messageId;
    references = [...idList(original.references), original.messageId];
    to ??= formatAddress(original.replyTo?.value?.[0] ?? original.from?.value?.[0]);
    subject ??= /^re:/i.test(original.subject ?? "")
      ? original.subject
      : `Re: ${original.subject ?? ""}`;
  }
  if (to === undefined) throw new Error("to is required (or reply_to_uid, to answer a message)");
  if (subject === undefined) throw new Error("subject is required (or reply_to_uid)");

  const domain = user.split("@")[1] ?? "localhost";
  const messageId = `<${randomUUID()}@${domain}>`;
  const raw = buildMime({
    from: noLineBreak("from", user),
    to: addressList("to", to),
    cc: input.cc === undefined ? undefined : addressList("cc", input.cc),
    subject: noLineBreak("subject", subject),
    body: input.body,
    inReplyTo:
      inReplyTo === undefined ? undefined : bracketed(noLineBreak("in_reply_to", inReplyTo)),
    references: references.map((id) => bracketed(noLineBreak("references", String(id)))),
    messageId,
  });

  // The Drafts folder is found by its \Drafts special-use flag, so it works whatever language the account
  // is in ("Drafts", "Entwürfe", "[Gmail]/Drafts"). Without the flag there is nowhere safe to write.
  const folder = (await client.list()).find((box) => box.specialUse === "\\Drafts");
  if (!folder) throw new Error("this account has no mailbox flagged \\Drafts");
  const stored = await client.append(folder.path, raw, ["\\Draft"], new Date());
  return {
    mailbox: stored?.destination ?? folder.path,
    ...(stored?.uid !== undefined && { uid: stored.uid }),
    message_id: messageId,
  };
}

async function markSeen(client, input) {
  const uid = uidOf(input);
  const lock = await client.getMailboxLock(mailboxOf(input));
  try {
    // false means it was already seen, which is the state asked for; a real failure throws.
    await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    return { ok: true, uid };
  } finally {
    lock.release();
  }
}
