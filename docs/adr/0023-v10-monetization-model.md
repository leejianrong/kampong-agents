# ADR-0023: V10 monetization model — per-seat business pricing, free for individuals

- Status: Accepted
- Date: 2026-09-18
- Deciders: Jian (product owner)

## Context

A product/business review of the repo (2026-09-18) found the full V5 multi-tenant substrate
(Postgres + RLS, Better Auth workspaces, an encrypted BYOK vault, a durable hosted run manager)
built and tested, but zero monetization code anywhere in the tree — no `stripe`, `billing`,
`subscription`, or `pricing` reference in `packages/` or `apps/`. ADR-0022 named the gap but
deferred it: *"Free/paid tier metering sits on the deployment record, later"*, without settling
what gets metered. KAN-1514 was filed to force that decision before KAN-1436 (webhook ingress +
deployment record) writes a schema that assumes the wrong dimension.

A planning discussion (2026-09-18) settled the business model: **this is a B2B SaaS** — free for
individuals, monthly/yearly per-seat pricing for businesses.

## Decision

**Pricing dimension: per-seat subscription (monthly or yearly), not usage metering.** Runs/month
and live-workflow-count metering (the alternatives ADR-0022 gestured at) are both rejected as the
primary pricing lever — seats are.

- **Free tier: individual / personal workspaces.** No billing integration, no enforced cap, for
  a workspace used by a single person for their own agents. This matches the developer/self-host
  persona this project has served since V1-V9 — they should never hit a paywall for personal use.
- **Paid tier: business/enterprise workspaces, billed per seat.** A workspace with more than one
  member is a business workspace; its subscription quantity tracks its member count.
- **Seats map directly onto Better Auth's `organization` member count (ADR-0015).** No new
  seat-tracking concept is needed — `workspace_members` (ADR-0014) already is the seat list.
  Inviting a member increases billed seats; removing one decreases them.
- **Personal vs business is a self-declared workspace attribute at creation time (`workspace.plan`:
  `personal` | `business`), not a verified business-entity check.** No KYB, no automated
  detection. This is a trust-based boundary: a business could create solo "personal" workspaces to
  avoid billing. Accepted as a known, bounded risk at this stage — there is no paying customer yet
  to defraud, and building fraud detection ahead of having a single subscriber would be exactly the
  over-engineering this project's staged-scoping approach exists to avoid. Revisit if abuse is
  actually observed post-launch, not before.
- **Enforcement point: the V10 "Deploy" action (KAN-1438).** Deploying a live workflow on a
  business-plan workspace requires an active subscription in good standing; personal workspaces
  deploy freely.

### Consequence for KAN-1436's deployment-record schema

The deployment record does **not** need run-count or usage-metering columns for pricing purposes.
This supersedes ADR-0022's "shaped to allow counting" framing, which assumed usage metering would
be the pricing lever. `deployments` stays scoped to lifecycle only: workspace/spec reference,
webhook URL, status (live/paused), timestamps. Billing state lives in a separate `subscriptions`
table (new, this ADR), not folded into the deployment record.

### New component: billing integration (not previously scoped anywhere)

This is real new scope, not assembly of existing V5/V9 primitives like the rest of V10:

- A payment provider integration — **Stripe Billing** (per-seat subscriptions, Customer Portal for
  self-serve plan management) is the natural default given this is a solo-operator project; no
  other provider was evaluated because Stripe's per-seat subscription primitive is a direct match
  and there's no existing reason (data residency, an existing vendor relationship) to look further.
- New tables: `workspace.plan` (`personal` | `business`) and `subscriptions` (workspace_id,
  stripe_customer_id, stripe_subscription_id, seat_count, status, current_period_end).
- A webhook handler syncing Stripe subscription events (created/updated/canceled) into
  `subscriptions`, and syncing `workspace_members` changes (invite/remove) into the Stripe
  subscription's quantity.
- This needs its own card(s) under EPIC-215 (V10), not folded into KAN-1436/1437/1438's existing
  scope.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Runs/month metering | Doesn't match the chosen B2B-seat positioning; usage-based pricing punishes exactly the heavy-usage customers a per-seat model wants to keep happy, and requires building usage tracking/rating infrastructure this project doesn't have. |
| Live-workflow-count metering | Simpler than usage metering but still the wrong lever for a per-seat B2B pitch — a 50-person company running 2 workflows shouldn't pay less than a 2-person company running 10. |
| Flat-rate SaaS fee regardless of seats | Leaves revenue on the table for larger customers and doesn't match "per seat" as stated; per-seat billing was the explicit ask. |
| Automated business-entity verification (KYB) at signup | Meaningful engineering effort with no fraud observed yet to justify it; self-declared plan choice is the appropriate v1 answer, revisited only if abuse actually appears. |

## Consequences

- `packages/server` gains a new external dependency (Stripe SDK) and a webhook endpoint, alongside
  Better Auth and the LiteLLM gateway it already depends on.
- KAN-1514 is resolved by this ADR and should be closed with a reference to it.
- A new billing-integration epic/cards are needed under V10 before the "Deploy" action (KAN-1438)
  can actually enforce the paid tier; KAN-1436/1437 (webhook ingress, connector secrets) are
  unaffected and can proceed independently, since they don't depend on billing state.
- `workspace.plan` becomes a new authorization dimension alongside V6's RBAC roles (ADR-0017) —
  V6's RBAC middleware and this ADR's plan-gating middleware are separate concerns that happen to
  both gate on workspace context, the same pattern ADR-0015 established for auth and RLS sharing
  one `workspace_id` seam.

## Open questions for implementation to revisit

- Whether a personal workspace can later be converted to a business workspace in place (adding a
  second member) versus requiring a new workspace — affects whether `workspace.plan` needs to be
  mutable post-creation.
- Grace-period behavior when a subscription lapses (payment failure): read-only degrade vs hard
  lock, and how long before a lapsed business workspace's live deployments are paused.
- Whether yearly billing gets a discount versus monthly, and what the actual per-seat price point
  is — pure pricing/GTM decisions out of scope for this ADR.
