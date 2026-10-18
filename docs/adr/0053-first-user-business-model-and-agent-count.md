# ADR-0053: First user, business model, and agent count are not positioning

- Status: Accepted
- Date: 2026-10-19
- Deciders: Jian (product owner)

## Context

A UX and competitor review on 2026-10-19 drove the real product in a browser and studied n8n, Gumloop,
Activepieces and Windmill. Two things came out of it. The canvas is hard to use because it cannot be edited
directly (nodes do not respond to click, drag or Delete; every change goes through a toolbar form). And the
product's written identity had drifted into a developer tool: "dev-first, canvas-code duality, single-agent",
with the first-user question never settled in a decision record.

The product owner then answered the open questions:

- The first user is a **non-technical person who can write a good prompt for an LLM**, not a developer.
- **Hosting is the business.** A paid **enterprise licence to self-host**, in the way GitLab sells one, is also on the
  roadmap.
- "Single agent" was never meant as positioning. The product is open to single-agent, multi-agent and anything else.

ADR-0001 limited v1 to one agent per spec so the canvas/YAML duality could be proven first. That was a build-order
decision. It ended up in the `AGENTS.md` tagline, the README and the docs as if it described the product.

## Decision

1. **First user.** The product is built first for someone in operations, support, marketing, finance or sales who
   can prompt an LLM, cannot read a stack trace, and will not install Node or edit an `.env` file. Developers stay
   supported (CLI, local mode, export) and are the secondary audience: they bring the product into a company and
   are the buyers of the self-host licence.
2. **Business model.** Direction, not final pricing:
   - **Hosted** is the primary product and the business. For this user it is the product from day one, not a later add-on.
   - **Enterprise self-host licence**, open-core style: SSO/SAML, RBAC, audit log, PII controls and support (the V6
     work) become a revenue line, not an unscheduled possibility.
   - Exact tiers and the meter are **not decided here**. Competitor evidence (n8n per execution, Activepieces per run,
     Gumloop stacked credits plus a fee) is input to a later pricing ADR.
3. **Agent count is not positioning.** "Single-agent" leaves the product description (`AGENTS.md`, README, docs).
   ADR-0001 stays as the record of v1 scope: one agent per spec file today, `sub_agents` room kept in the schema.
   Multi-agent (V7) is open and unscheduled; nothing here depends on it.
4. **Chat-first authoring becomes core to the primary path.** Prompt-to-workflow generation (V8) is promoted from
   "later" to part of the main authoring flow, with the canvas as the place a user checks and fixes what was
   generated. ADR-0012 (status Proposed) is the starting point and needs to be accepted or replaced.
5. **Hosted has to run the full spec.** The hosted server does not run spec 1.1 today (ADR-0027), so the part of the
   engine this user needs is not available to them. Lifting that limit is on the critical path.
6. **The canvas/YAML duality becomes the trust layer, not the headline.** What the user sees is a workflow they can
   inspect, try on recorded data, version and undo. The file and git story is for developers and for IT review.

## Not decided here (open)

- **Licence of the core.** It is Apache 2.0 today. That lets anyone run a hosted copy. Whether to keep it, or move
  toward AGPL or source-available to protect hosting revenue, needs its own ADR and legal advice before a hosted launch.
- **Model keys on hosted:** bring-your-own (the BYOK vault of ADR-0016) or run models and resell.
- **Analytics policy for the hosted product.** "No telemetry by default" is a local-CLI convention. The hosted product
  needs its own stated policy.
- **Pricing tiers and meter.**

## Consequences

- **ADR-0001:** still accurate as v1 scope; no longer positioning.
- **ADR-0023:** the per-seat, free-for-individuals model is no longer settled. Its Deploy-gate idea may survive; the
  pricing dimension is reopened, and an enterprise self-host licence is added to the picture.
- **ADR-0012:** to be accepted or replaced as part of the generator work.
- **ADR-0008:** hand-editing in an external IDE stays supported in local mode but is no longer the product's primary
  story (see ADR-0054).
- `AGENTS.md`, README, `PLAN.md`, `SLICES.md` and the docs are updated to match.
- The board gets a new priority order: editing foundation, hosted that runs 1.1, prompt-to-workflow, trust features,
  templates and onboarding, enterprise licence, billing.
- Usability tests use non-technical, prompt-literate participants.
