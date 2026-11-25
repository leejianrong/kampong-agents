# ADR-0066: First hosted customers run on the homelab, sold as a preview with no SLA

- Status: Accepted (2026-11-25, by the product owner)
- Date: 2026-11-25
- Deciders: Jian (product owner)

## Context

The hosted server runs nowhere yet. ADR-0013 chose k3s on the owner's homelab as the first home, and the plan in
`docs/hosted/` puts the service at `kampong.abangai.dev`. An enterprise buyer review (2026-11-24) said not to run
paid pilots on a single homelab site, because it has no failover, no status history and no SLA. The owner's
answer is to keep the homelab for the first customers but be plain about what it is, and to make sure anyone who
needs more can run Kampong themselves.

## Options

1. **A cloud host from day one.** Gives failover and a story for an SLA. Costs money before any customer has
   asked for hosted, and the work to move is the same whenever it happens.
2. **The homelab, presented as if it were production.** Rejected: a customer would assume an uptime the box
   cannot deliver.
3. **The homelab, labelled a preview with no SLA, with a published way to self-host.** Chosen.

## Decision

- The first customers run at `https://kampong.abangai.dev` on the homelab k3s cluster.
- The app shows a notice on every screen while it is a preview. The server reads it from `PREVIEW_NOTICE` and
  reports it on `/healthz`; the hosted canvas pins it to the top. Suggested text: "Preview: no uptime
  guarantee. Back up anything you cannot lose."
- No SLA is offered, and the status page (KAM-330) says "preview" until that changes.
- Anyone who wants more control can self-host or try it locally on minikube or k3s (KAM-343, in the first
  customer gate), which is also an enterprise expectation.
- **Replicas.** The chart defaults to one. Two replicas wait on KAM-348 (an approval must be resolvable on any
  replica, today it returns 409 on a replica that is not running the run) and on KAM-340 (a test that two
  replicas fire a scheduled tick once). Rate limits are per replica (KAM-322).
- **Backups.** A backup that has not been restored is not a backup. KAM-329 runs and times a restore before any
  customer pays.
- **Invoicing** is manual (KAM-346) and says so.

## When to move to a cloud host

Move when any one of these is true: a customer asks for an SLA or a contractual uptime, a second customer
depends on it for something time-sensitive, the homelab link or power has caused an outage a customer noticed,
or the restore drill shows recovery slower than the preview terms promise. The move is a Helm install elsewhere
plus a database restore, so the chart and the runbook are written to be host-independent.

## Consequences

- A single site is a single point of failure, and the preview wording is what keeps that honest.
- The label has to be turned on in the real values file; the chart default is empty so a local install is not
  stamped.
- Sales conversations that need an SLA end here until the move.
