// Mailboxes for the support-triage tests and fixture recorder (KAM-126). `seen: true` messages are never listed.
const from = { name: "Ana Cruz", address: "ana@client.example" };
const OLD = {
  uid: 3,
  from: { name: "Old Thread", address: "old@client.example" },
  subject: "Thanks!",
  text: "Thanks, that fixed it.",
  messageId: "<old-3@client.example>",
  seen: true,
};

export const USER = "support@example.com";

export const CONFIDENT = {
  user: USER,
  messages: [
    OLD,
    {
      uid: 5,
      from,
      subject: "How do I reset my password?",
      text: "Hello, I forgot my password and cannot log in. How do I reset it?",
      messageId: "<orig-5@client.example>",
      references: ["<earlier-0@client.example>"],
      seen: false,
    },
  ],
};

export const UNSURE = {
  user: USER,
  messages: [
    OLD,
    {
      uid: 8,
      from: { name: "Ben Lim", address: "ben@client.example" },
      subject: "Change the email on my account",
      text: "Please change the email address on my account to ben.new@client.example. I no longer have the old one.",
      messageId: "<orig-8@client.example>",
      seen: false,
    },
  ],
};

export const EMPTY = { user: USER, messages: [OLD] };
