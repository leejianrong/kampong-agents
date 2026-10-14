# ADR-0048: Gmail over IMAP as a separate component (`kampong/gmail-imap`)

Status: accepted (KAM-122)

## Context

support-triage has to read an inbox and leave a reply for a person to send. `kampong/gmail` (ADR-0030) only
sends, over the Gmail REST API with an OAuth token, which a developer running locally rarely has. The planning
decision (SLICES.md V11, F6) was IMAP with an app password for now, and the Gmail REST API with OAuth as the
later, managed path.

## Decision

- **A new component, not new ops on `kampong/gmail`.** The two have different credentials (an address and an
  app password, against a bearer token), a different host (`imap.gmail.com`, against `gmail.googleapis.com`)
  and a different transport. Folding them together would widen `kampong/gmail`'s permissions for every spec
  that only sends. `kampong/gmail-imap@1.0.0` is a `kind: module`: IMAP is a stateful socket protocol, not a
  request template.
- **Ops:** `check_login` (the credential probe), `list_unseen`, `get_message`, `create_draft`, `mark_seen`.
  Each op connects, does its work and logs out; there is no connection kept between steps.
- **Nothing is marked read implicitly.** `list_unseen` and `get_message` open the mailbox read-only and fetch
  with `BODY.PEEK`, so a run that fails after reading leaves the message unread and a retry sees it again.
  `mark_seen` is an explicit step, placed after the work is done.
- **Drafts are found by the `\Drafts` special-use flag**, never by name, so the account's language does not
  matter (`Drafts`, `Entwürfe`, `[Gmail]/Drafts`). An account without the flag is an error rather than a guess.
  A draft is plain text, base64 encoded, and nothing is sent. With `reply_to_uid` it is threaded: `In-Reply-To`
  is the original's Message-ID, `References` is the original's references plus that id, and `to` and `subject`
  default from the original (`Reply-To` or `From`, and `Re: ...`).
- **Header values are one line.** `to`, `cc`, `subject`, `in_reply_to` and `references` refuse a line break, as
  `kampong/gmail` does, so a value taken from an email cannot add a `Bcc` header. Addresses are checked for
  shape.
- **Credentials are two secret slots**, `user` (`GMAIL_ADDRESS`) and `password` (`GMAIL_APP_PASSWORD`), both
  bound to `imap.gmail.com:993`. Because both are secrets, a recorded fixture redacts the address as well as the
  password, so a replayed message shows `[REDACTED]` where the account's own address was. A refused login
  carries `status: 401` so `kampong doctor --probe` can tell it from an unreachable server.
- **Dependencies:** `imapflow` and `mailparser`, pinned exactly in the manifest's `deps` and in
  `packages/engine/package.json`. The versions are the newest more than two weeks old when this was written
  (both libraries release almost daily), not the newest.

## What is not enforced

The module's sockets are opened by `imapflow`, not by `ctx.fetch`, so the runtime cannot refuse a host. The
manifest declares `egress: [imap.gmail.com:993]` and the host is a constant in the code (never read from input), but
that is a statement a reviewer can hold the module to, not a wall (ADR-0031 points 3 and 4). The module still
receives its secrets only through `ctx.secrets`. A sandboxed runner would close this gap for every module at
once, which is why it stays the open item in ADR-0031.

## Consequences

- **Not verified against a live account.** The tests drive the module with a scripted `imapflow` client and
  parse the MIME it builds with the real `mailparser`; the library's method names, options and `PEEK` behaviour
  were checked against its shipped type definitions and source. A live smoke test with an app password is
  still owed, as it is for the other first-party connectors.
- An export that uses the component installs the two dependencies (`buildPackageJson` adds a module's `deps`).
- The hosted server does not run modules without a sandboxed runner (ADR-0031 point 5), so this is local and
  export only for now.
- Gmail's REST API with OAuth remains the managed path; it would be a later version of `kampong/gmail` or a
  sibling, with its own credentials.
