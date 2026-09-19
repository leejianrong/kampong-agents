# ADR-0024: V10 managed-SaaS hosting stays on the homelab, with an explicit revisit trigger

- Status: Accepted
- Date: 2026-09-18
- Deciders: Jian (product owner)

## Context

V5 already targets a self-hosted k3s homelab cluster (ADR-0013) for the hosted/BYOK backend. V10
(KAN-1437) extends the existing encrypted BYOK vault (KAN-1229, envelope encryption) to store
connector credentials (Slack bot tokens, Gmail OAuth tokens, etc.) alongside model API keys, for
real customers' business workflows. A product/business review (2026-09-18) flagged that this means
real strangers' third-party credentials will be resolved from homelab infrastructure once V10
ships, a different trust profile than V5's original developer-BYOK use case, and asked whether the
managed path needs to move to a real hosting provider before that happens.

## Decision

**Stay on the homelab k3s cluster for now.** Do not block KAN-1436/1437/1438 on a hosting-provider
migration. Revisit before either of these two triggers, whichever comes first:

- The workspace count on `workspace.plan = business` (ADR-0023) exceeds a small trusted-beta
  cohort — **5 paying business workspaces** is the default threshold; adjust if real signup
  velocity makes that number obviously wrong once it's actually being observed.
- Before any public marketing push, a paid-acquisition channel, or listing the product anywhere
  that isn't personal/direct outreach (i.e., before intentionally growing beyond word-of-mouth).

"Revisit later" with no criterion tends to never actually get revisited — this ADR exists
specifically to give that revisit a concrete trigger instead of leaving it as an open-ended
intention.

### Why this is an acceptable interim risk, not a blind spot

The existing V5 controls already reduce (not eliminate) the exposure a homelab-hosted vault
creates:

- Connector/model credentials are envelope-encrypted at rest (KAN-1229); a compromised database
  dump doesn't yield plaintext tokens.
- RLS enforces workspace isolation at the query layer (KAN-1225), with an adversarial test suite
  proving cross-tenant reads fail even under a malformed query (KAN-1232).
- KAN-1516 (filed alongside this ADR) extends that same adversarial-test discipline to the
  connector-token path specifically, so the new V10 surface gets the same scrutiny the existing
  BYOK-key surface already has before it ships.

What these controls do **not** cover, and what remains the actual accepted risk: physical/network
access to the homelab itself, single-operator operational risk (no on-call, no SOC2/compliance
backing, no infrastructure redundancy beyond what ADR-0013's backup/DR plan provides), and the
reputational/legal exposure of a breach involving real customers' third-party tokens rather than
this project's own data. This is a real risk being knowingly accepted for a beta-scale cohort, not
a risk being overlooked.

## Alternatives considered

| Option | Why not (yet) |
| ------ | ------- |
| Migrate to a managed cloud host (Fly, Render, a cloud VPS) before KAN-1436-1438 land | Meaningful infra migration effort with no paying customer yet to justify it before the core V10 mechanics (webhook ingress, deployment record, connector-secret resolver) even exist. Matches ADR-0022's own "foundation first" sequencing logic. |
| Migrate immediately, in parallel with KAN-1436-1438 | Splits attention across infra migration and the actual product mechanics at the exact moment both are unproven; better to prove V10 works at all on infrastructure that already exists, then migrate once there's a concrete cohort size or GA date forcing the question. |
| Never migrate, treat homelab as permanent | Explicitly rejected — the revisit triggers above exist precisely because homelab custody of third-party customer credentials is not an acceptable permanent posture once this is a real paid product with more than a handful of customers. |

## Consequences

- KAN-1436/1437/1438 proceed on the existing k3s/Postgres/RLS/BYOK-vault foundation with no new
  hosting work blocking them.
- KAN-1515 is resolved by this ADR and should be closed with a reference to it.
- A future hosting-migration epic is implied but not filed yet — file it when either trigger above
  is actually hit, not speculatively now.
- The homelab's backup/DR posture (ADR-0013) and the BYOK vault's encryption (KAN-1229) become
  load-bearing for this accepted-risk stance; a regression in either (e.g., an unencrypted
  credential path, a broken backup) escalates this from "accepted interim risk" to "should have
  migrated already" and should trigger an immediate re-review of this ADR, not wait for the seat
  or marketing threshold.
