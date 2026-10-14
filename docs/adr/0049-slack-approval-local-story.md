# ADR-0049: Slack approvals on a laptop: say what is needed, do not open a tunnel

Status: accepted (KAM-124)

## Context

A spec with `approval_notifier` posts Approve and Reject buttons to Slack. Slack delivers a click by calling a
public HTTPS URL, which a laptop does not have. The `mastra-projects/support-triage` and `incident-responder`
demos hit four traps (a public URL is required; a relay such as smee.io re-sends the click as JSON, which breaks
the HMAC; Socket Mode on silently disables HTTP interactivity; an app has one Interactivity URL) and the fix for
the second was hand-written in each demo. V11 needs a stated answer for `kampong dev` and `kampong serve`: ship a
tunnel, or say plainly that approval needs a public URL.

## Decision

- **No first-party tunnel.** Chosen by the product owner. A built-in tunnel sends a user's traffic through a third
  party they did not pick, needs a downloaded binary or an account, and conflicts with "nothing phones home unless
  you opt in". It would also be one more process to supervise, and a free tunnel's address changes on restart, so
  it would not remove the setup step anyway. An opt-in `--tunnel` flag was considered and left out for the same
  reasons; it can be added later without changing anything here.
- **Say it, once, where it matters.** `kampong serve` prints at startup what Slack needs (a public HTTPS URL to
  `/slack/interactions`, one Request URL per app, Socket Mode off) and warns when `SLACK_SIGNING_SECRET` is unset,
  since every click would be refused. `kampong dev` says that the canvas uses its in-app dialog so nothing needs
  to be public, and points at the docs. Both print only for a spec that has an `approval_notifier`
  (`packages/cli/src/slack-notice.ts`).
- **The relay problem is fixed in the product, not in docs.** `recoverSlackRawBody` rebuilds the bytes Slack signed
  from a relayed `{ payload }` JSON body (`payload=` plus RFC 3986 encoding, spaces as `+`). The signature is then
  verified against that, so the check stays fully on: a forged or altered click is still a `401`. It is used by
  `kampong serve` and by the exported server. A body with no string `payload` recovers to the empty string, which
  never verifies.
- **A run never depends on Slack.** `POST /runs/:id/approve` and `POST /approvals/:key/approve` always work, so the
  whole approval path can be exercised without the buttons.
- **Documented** in `docs/tutorial/slack-approvals.md`: the four traps, the setup, and a checklist for a click
  that does nothing.

## Consequences

- A person who wants the Slack buttons on a laptop still has to run their own tunnel, and the docs say how. That is
  the cost of the decision, accepted so the default stays local-first.
- Socket Mode and a wrong Request URL cannot be detected from this side (no request ever arrives), so the notice
  and the checklist are the only mitigation. The hosted app (V5/V10) has a public URL by construction and does not
  have this problem.
- The Slack interaction ingress for the hosted server remains V11-P2 (KAM-130).
