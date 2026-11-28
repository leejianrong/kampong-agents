# Security and data handling

This page says what the hosted server does with customer data and how to report a vulnerability. Every statement in
the table below was checked against the code on **2026-11-28** (commit `d661bbd`) and names where. If the code
changes, the page has to change with it; a claim that stops being true is a bug in this page.

This is a **preview** run on one homelab site with no uptime guarantee (ADR-0066). The page is written for a buyer's
security review, so it lists what is **not** in place as plainly as what is.

## Report a vulnerability

Report it **privately** through a
[GitHub private security advisory](https://github.com/leejianrong/kampong-agents/security/advisories/new). The
project's [security policy](https://github.com/leejianrong/kampong-agents/blob/main/SECURITY.md) is the policy for the
hosted service too: we aim to acknowledge within three working days, say what we plan to do within ten, and credit you
if you want. The hosted server publishes the same contact at `/.well-known/security.txt` when the operator sets it
(`security.contact` in the chart; the preview uses the advisory address above), so a scanner or a buyer's team finds it
without asking.

What the hosted service adds to that policy:

- **In scope.** The hosted server at the production address, the canvas it serves, and the chart in `deploy/`.
- **Out of scope.** Other customers' workspaces (never test against someone else's data), denial of service, social
  engineering, and findings that need a compromised device.
- **Safe harbour.** We will not take action against someone who reports in good faith, stays inside the scope above,
  reads no more data than needed to show the problem, and gives us reasonable time before telling anyone else. The
  operator confirms this wording before the first customer; it is a proposal until then.

## What the hosted server does

| Claim                                                                                      | What the code does                                                                                                                                                                                                                                                                                                        | Where                                                                  |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| One workspace cannot read or write another's data                                          | Row-level security is **enabled and forced** on `specs`, `layouts`, `runs`, `deployments`, `workspace_members`, `byok_keys`, `workspace_secrets`, `state_entries` and `audit_events`. Every request and every run works inside a transaction that sets the workspace, and the database refuses rows outside it. | `drizzle/0001`, `0007`, `0009`, `0011`, `0013`, `0017`, `0021`; `src/db/workspace-scope.ts` |
| That holds under attack, not only in normal use                                            | Tests try a query that names another workspace, a UNION, a bare select, an update, an insert stamped with the other's id, a blank or malformed scope, and a webhook-started run reading another workspace's token. A canary check proves the isolation test fails against a leaking server. They run in CI. | `test/integration/db/rls-adversarial.test.ts`, `test/integration/routes/secret-isolation.test.ts`, `e2e/hosted-smoke/smoke.mjs` |
| Stored model keys, connector secrets and webhook secrets are encrypted at rest             | AES-256-GCM with a fresh random nonce per value, under one root key supplied from a Kubernetes Secret (`BYOK_ROOT_KEY`). The API returns only a mask (the last four characters), never the value or the ciphertext. A secret is decrypted when a run starts and held only in that run's environment.            | `src/crypto/envelope.ts`, `src/secrets/resolve.ts`, `src/routes/secrets.ts`, `src/routes/byok.ts` |
| Passwords are not stored                                                                   | Sign-in is by Better Auth, which stores a scrypt hash.                                                                                                                                                                                                                                                                    | `src/auth/config.ts`; Better Auth `crypto/password`                    |
| The server does not log what customers send                                                | The web framework's request logging is off, and an audit event never holds a request body. Errors are written to the process log; those messages can name a workspace or a step but are not built from request bodies or secret values.                                                                          | `src/server.ts` (`logger: false`), `src/audit/audit.ts`                |
| There is no telemetry or analytics                                                         | The server has no analytics, error-reporting or tracking dependency and makes no call home.                                                                                                                                                                                                                                | `packages/server/package.json`                                         |
| Kampong does not train models on customer data                                             | Kampong trains nothing. A workflow's prompts and data go to the model provider the customer chose, with the customer's own key, under **that provider's** terms. Check them: they decide whether the provider keeps or trains on what it receives.                                                                  | `src/model/resolve.ts`                                                 |
| A workflow cannot aim the server at internal addresses                                     | Tool, connector and model requests may reach public addresses only (private, loopback, link-local and cloud-metadata ranges are refused, also after DNS and on every redirect). A refusal is written to the audit log.                                                                                        | `src/run/ssrf-guard.ts`, ADR-0058, KAM-337                             |
| Changes and refusals are recorded and cannot be edited by the application                  | An append-only audit table (the database policy allows select and insert only), written for every successful change and every refused one. Admins export it as JSON.                                                                                                                                                      | `src/audit/audit.ts`, `drizzle/0021`, `GET /api/audit`                 |
| Access follows roles                                                                       | Four roles (admin, editor, approver, viewer), checked on every route through one function that requires a permission, so a new route cannot skip it.                                                                                                                                                                     | `src/auth/roles.ts`, `src/auth/request-context.ts`                     |
| A workspace cannot use more than its share                                                 | Limits on runs at once, runs a month and minutes per run, per workspace.                                                                                                                                                                                                                                                  | `src/run/limits.ts`, KAM-323                                           |
| Deleting a workspace deletes its data                                                      | Every table that holds workspace data references the workspace with `ON DELETE CASCADE`, so removing the workspace removes its specs, runs, secrets, deployments, state and audit events. There is no self-service button; the operator does it on request.                                                      | `src/db/schema.ts`                                                     |
| Data stays in one place                                                                    | One database, on one site (the operator's homelab during the preview). Backups go to an S3-compatible bucket whose location the operator chooses and states in the subprocessor list. There is no second region.                                                                                                | ADR-0066, [subprocessors](subprocessors.md)                            |
| A restored backup works                                                                    | A drill restores into a new cluster and compares every row, and fails the build if it stops working.                                                                                                                                                                                                                      | [restore runbook](restore-runbook.md)                                  |

## What is not in place

Said plainly, so a review does not have to find it:

- **No certification or outside test.** No SOC 2 report, no ISO 27001, no independent penetration test (SOC 2 is
  KAM-332).
- **No single sign-on or SCIM.** Accounts are email and password, or GitHub. SSO and provisioning are planned (KAM-62,
  KAM-333).
- **No email.** The server sends no email, so there is no email verification and no self-service password reset.
- **No customer-managed keys.** One root key encrypts every workspace's secrets (KMS is KAM-334).
- **No per-workspace egress allowlist or network policy** (KAM-335, KAM-336). The public-addresses-only rule is the same
  for everyone.
- **Reads are not audited.** The audit log records changes and refusals, not who looked at what.
- **No automatic expiry of runs, traces or audit events.** They stay until the workspace is deleted (trace retention
  is KAM-339).
- **No self-service export or deletion.** Both are done by the operator on request.
- **One site, one replica, no SLA.** An outage or a lost site is possible; the restore drill shows recovery from the
  backup bucket, not that the bucket survives the site.
- **Rate limits are per replica**, and a run's live stream is visible only on the replica running it.

## For the operator

- Set `security.contact` (a `mailto:` or `https:` address) and `security.policy` in the chart's values, for example
  `https://github.com/leejianrong/kampong-agents/security/advisories/new` and
  `https://github.com/leejianrong/kampong-agents/blob/main/SECURITY.md`. Check
  `https://<host>/.well-known/security.txt`. Its `Expires` moves with the clock, about six months ahead.
- Keep a separate copy of `BYOK_ROOT_KEY`; losing it makes every stored secret unreadable.
- Review this page whenever a row in the table changes. The date at the top is the last time every row was checked.
