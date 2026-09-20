import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

// Real IMAP access to the dedicated demo inbox via a Gmail App Password --
// no OAuth app registration, no googleapis SDK. Kampong-agents' own product
// Gmail connector (KAN-1430, packages/engine/src/http-tool.ts) only does
// `gmail_send` via a pre-obtained bearer token -- it has no polling, no
// listing, no draft creation at all. This demo needs all three, which is
// why it reaches for real IMAP instead: a bearer token alone can't express
// "read my inbox" or "leave a draft", only "send one message" (see README
// gap-analysis).

export interface RawIncomingMessage {
  uid: number;
  messageId?: string;
  from: string;
  subject: string;
  text: string;
  references: string[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example).`);
  return value;
}

function openClient(): ImapFlow {
  return new ImapFlow({
    host: process.env.IMAP_HOST ?? "imap.gmail.com",
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: true,
    auth: {
      user: requireEnv("IMAP_USER"),
      pass: requireEnv("IMAP_APP_PASSWORD"),
    },
    logger: false,
  });
}

/** Real IMAP SEARCH for unseen inbox messages, parsed into what the classifier needs. Marking \Seen (not moving/deleting) is what prevents re-processing on the next poll. */
export async function fetchNewTickets(): Promise<RawIncomingMessage[]> {
  const client = openClient();
  await client.connect();
  const messages: RawIncomingMessage[] = [];
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) return messages;

      for await (const message of client.fetch(uids, { source: true, uid: true }, { uid: true })) {
        if (!message.source) continue;
        const parsed = await simpleParser(message.source);
        messages.push({
          uid: message.uid,
          messageId: parsed.messageId,
          from: parsed.from?.value[0]?.address ?? "unknown@sender",
          subject: parsed.subject ?? "(no subject)",
          text: (parsed.text ?? "").trim(),
          references: parsed.messageId ? [parsed.messageId] : [],
        });
      }

      await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return messages;
}

async function resolveDraftsMailbox(client: ImapFlow): Promise<string> {
  const mailboxes = await client.list();
  const drafts = mailboxes.find((box) => box.specialUse === "\\Drafts");
  // Gmail's default English locale names it "[Gmail]/Drafts", but the
  // special-use flag is the real, locale-independent way to find it --
  // hardcoding the path breaks for any non-English Gmail UI language.
  return drafts?.path ?? "[Gmail]/Drafts";
}

export interface DraftReplyInput {
  to: string;
  subject: string;
  inReplyTo?: string;
  references: string[];
  body: string;
}

/** Leaves a real draft in the inbox's real Drafts folder via IMAP APPEND -- never sends. The demo's job is to draft, not to act on the customer's behalf without review. */
export async function createDraftReply(input: DraftReplyInput): Promise<void> {
  const composer = new MailComposer({
    from: requireEnv("IMAP_USER"),
    to: input.to,
    subject: input.subject.startsWith("Re:") ? input.subject : `Re: ${input.subject}`,
    text: input.body,
    inReplyTo: input.inReplyTo,
    references: input.references,
  });
  const raw = await new Promise<Buffer>((resolve, reject) => {
    composer.compile().build((err, message) => (err ? reject(err) : resolve(message)));
  });

  const client = openClient();
  await client.connect();
  try {
    const draftsPath = await resolveDraftsMailbox(client);
    await client.append(draftsPath, raw, ["\\Draft", "\\Seen"]);
  } finally {
    await client.logout();
  }
}
