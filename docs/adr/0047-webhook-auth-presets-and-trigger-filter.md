# ADR-0047: Webhook auth presets, trigger `when` and `map`

Status: accepted (KAN-1848)

## Context

`POST /webhook` took any request. A real sender (GitHub, Slack, Alertmanager) proves itself with a signature
or a token, and the demos in `mastra-projects/` each hand-wrote that check. Version 1.1 specs also read the
request as `trigger.*` (ADR-0027, KAN-1841) and can answer synchronously (`respond: sync`, KAM-109), so the
auth decision has to sit in front of both. Three quirks from the demos shaped the design: GitHub signs the raw
body as `sha256=<hex>` in `X-Hub-Signature-256`; Slack signs `v0:<timestamp>:<body>` as `v0=<hex>` in
`X-Slack-Signature` with the time in `X-Slack-Request-Timestamp` and refuses anything beyond five minutes;
Alertmanager does not sign at all and sends `Authorization: Bearer <token>`.

## Decision

- **Shape (version 1.1 only).** On a webhook trigger: `auth: none | { type: bearer, secret_env } | { type:
hmac, header, algo: sha256|sha1, prefix?, encoding: hex|base64, timestamp_header?, window_s?, payload?,
secret_env }`, and `preset: github | slack | alertmanager | generic`. A preset expands to a concrete rule
  (`resolveWebhookAuth`); `auth` beside a preset supplies the `secret_env` and may override any field, but not
  the type. No `auth` and no preset is `none`, which is today's behaviour. `payload` is the signed text with
  `{body}` and `{timestamp}` (default `{body}`, or `{timestamp}.{body}` with a timestamp header; slack is
  `v0:{timestamp}:{body}`).
- **No literal secrets.** `secret_env` is the name of an environment variable (`NAME` or `${NAME}`, upper
  case, digits and `_`). Anything else is a validation error with the line of the field, and the message does
  not repeat the value. The check is a shape check: an upper-case literal would pass, so it protects against
  the common mistake, not a determined one.
- **Raw bytes.** The server's JSON and catch-all content-type parsers keep the body as a `Buffer`
  (`request.rawBody`) and parse from it; signatures are computed over those bytes, so re-formatted JSON, a
  form body, or non-UTF-8 content verifies exactly as the sender signed it.
- **Verification.** `crypto.createHmac` over the template, compared with `timingSafeEqual` after a length
  guard (a different length is simply unequal). Bearer compares SHA-256 digests of both sides, so lengths
  never differ. A timestamp must be digits (seconds); `|now - ts| > window_s` is refused in both directions
  (default 300 for a timestamped scheme). Hex signatures compare case-insensitively.
- **One answer for every failure.** A bad, missing, stale or malformed credential, and a secret variable that
  is not set (fail closed; the server logs which variable, never a value), all return `401
{ success: false, error: "Unauthorized" }`. Nothing says which check failed.
- **Order.** authenticate, then Slack `url_verification` (a signed request with `type: url_verification` on
  the slack preset is answered `200 { challenge }`, no run), then `when`, then `map`, then the server's
  `respond` mode. Auth is first so an unauthenticated caller learns nothing from `when`, `map` or a sync
  answer, and cannot hold a connection open.
- **`when`.** A JSONata expression over `trigger` (`trigger.headers.\`x-github-event\``, the body's fields,
`trigger.body`), evaluated as a condition (must be true or false). False means accepted-but-ignored: `200
{ success: true, ignored: true, reason }`, no run is created, and the server records it
  (`RunManager.recordIgnored`, the latest 100 at `GET /triggers/ignored`). An expression that cannot be
  evaluated is `422`, nothing runs.
- **`map`.** `name: <expression>` pairs over the same `trigger`. The result replaces the body's fields as
  `trigger.*`; `trigger.headers` and `trigger.body` stay the request's (`map` may not set those two names).
  A field that selects nothing is `null`. Credential-looking headers are not in `trigger.headers` (so the
  signature header is not readable by `when`/`map`/a step). `RunTrigger.fields` carries the result and is
  persisted with a pending approval.
- **Validation.** `when` and each `map` value are parsed at spec load, with the line of the field, and may
  read only `trigger`.
- **One implementation, three places.** `handleWebhookRequest` (engine, `webhook-trigger.ts`) does all of
  the above and is what `kampong serve` and the exporter's generated `src/server.ts` both call. The exporter
  vendors it (ADR-0010; parity-tested) with `webhook-auth.ts`, which has a byte-identical copy in
  `packages/spec/src` (as `schedule.ts`, ADR-0040) so the validator and the server apply the same rules.
  The export lists `secret_env` in `.env.example` and the README, and adds a README section.

## Consequences

- An accepted run is still answered `201` with its id (async), as before, not `202`: changing the status for
  every existing webhook user was not worth it for this card. `202` remains for a sync request that times
  out or waits for approval. Revisit if a sender needs 202 specifically.
- `/slack/interactions` (approval buttons) keeps its own fixed `SLACK_SIGNING_SECRET` check; it is not a
  trigger.
- A body larger than Fastify's 1 MiB default is refused before verification, as before.
- Ignored requests are kept in memory only (lost on restart); they are a debugging aid, not an audit log.
- The canvas form for these fields is KAN-1850. Multiple accepted secrets (rotation) and multi-signature
  headers (Stripe's `v1=...,v1=...`) are not supported.
