# ADR-0057: Hosted webhook secrets are generated per deployment

- Status: Proposed (KAM-203 part C). Needs the product owner's sign-off: it chooses how a hosted tenant provides a secret.
- Date: 2026-10-21
- Deciders: Jian (product owner)

## Context

A webhook trigger with `auth` or a `preset` (github, slack, alertmanager, generic) needs a secret to verify the
caller, named in the spec as `secret_env`. Locally that is an environment variable. ADR-0056 gave hosted runs an
empty environment, so a tenant cannot read the server's secrets, and there is no workspace tool-secret store
yet. Something has to supply the verification secret.

## Options

1. **Read it from the server's environment.** Rejected: that is the leak ADR-0056 closed.
2. **The tenant supplies the secret** (a new workspace secret store, BYOK-style). Familiar, and works for a
   sender that insists on its own value, but it needs the store that does not exist yet, and a UI to enter it.
3. **The server generates a secret per deployment and shows it once.** Chosen. No new store and nothing for the
   tenant to get wrong: a 256-bit random value, shown in the deploy response, pasted into the sender
   (GitHub, Slack and Alertmanager all let you set the secret or token).

## Decision

- `deployments.webhook_secret_ciphertext` (migration 0014) holds the secret, encrypted with the BYOK root key in
  the same envelope as `byok_keys` (AES-256-GCM). The column sits on `deployments`, which already has FORCE RLS.
- `PUT /api/specs/:id/deployment` generates it when the trigger needs one and none exists, and returns it once as
  `webhookSecret` (prefix `whsec_`). A redeploy keeps it; a GET never shows it.
  `POST /api/specs/:id/deployment/webhook-secret` rotates it (the old one stops at once).
- At fire time the ingress decrypts it and calls the engine's `handleWebhookRequest` with an environment of
  exactly `{ [secret_env]: secret }`. The spec's `secret_env` name is a label on hosted. Hosted therefore
  accepts and rejects the same requests as `kampong serve`, because it is the same code, and a same-named
  server environment variable never authenticates anything (tested).
- A trigger with auth but no stored secret (a spec edited after deploy) refuses every request.
- The ingress parses the body itself (raw bytes kept) in an encapsulated scope, since a signature is over the
  exact bytes.
- Hosted refuses a webhook with `respond: sync` at deploy: the ingress always answers with a run id.

## Consequences

- The secret is recoverable by the server (it must be, to compute an HMAC). Its protection is the root key, as
  for BYOK keys.
- A tenant who wants to choose the secret cannot until a workspace secret store exists; that store can later
  override this default.
- A sender that cannot be given a custom secret is not supported by this route.
