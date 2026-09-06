# ADR-0015: V5 auth and account model

- Status: Accepted
- Date: 2026-09-06
- Deciders: Jian (product owner)

## Context

V5 (KAN-1118) needs real user accounts and workspace membership — today there is exactly zero
concept of a user, session, or workspace anywhere in the codebase (confirmed by grep across
`packages/cli`/`packages/engine`: the only "session"/"workspace" hits are unrelated — a `kampong
dev` process-lifetime comment (`run-manager.ts:18`) and npm-workspace package resolution
(`cli.ts:255-273`), not multi-tenancy). This decision must not need to be thrown away when V6
(KAN-1122) adds SSO/SCIM — building an account system now that has to be replaced, not extended,
when enterprise SSO lands would be exactly the kind of rework this project's staged-scoping
approach exists to avoid.

## Decision

**Better Auth**, a TypeScript-native, framework-agnostic, self-hostable auth library, for V5's
account system — not a hand-rolled session/password/OAuth implementation, and not a
Next.js-coupled library (NextAuth/Auth.js) that doesn't fit a Fastify-served SPA as naturally.

- **Sign-in methods for V5:** email+password, plus GitHub OAuth (a natural fit for a
  developer-tool audience already comfortable authorizing a GitHub app). Both are supported
  directly by Better Auth's core and OAuth plugins with no custom cryptography or token-handling
  code written in this project.
- **Session strategy: server-side session cookies, not JWTs.** A single self-hosted backend
  (ADR-0013) has no need for stateless multi-region JWT validation; cookie sessions give a simpler,
  more auditable revocation story ("delete the session row") which matters more here than the
  marginal scalability JWTs would buy.
- **Workspace modeling: Better Auth's `organization` plugin**, which models
  organizations/members/roles directly — mapped onto this project's existing "workspace"
  vocabulary (ADR-0014's `workspace_members` table). This gives V6's RBAC (KAN-1123, ADR-0017) a
  role/permission primitive to build on directly, rather than V5 inventing its own membership model
  that V6 would need to reconcile with Better Auth's later.
- **SSO plugin, adopted now but unused until V6.** Better Auth ships an `sso` plugin implementing
  OIDC and SAML as a relying party (i.e., accepting a customer's own identity provider as the
  authentication source for their workspace) — exactly what V6's SSO/SCIM requirement (KAN-1122)
  needs. Choosing Better Auth now, with this plugin available but dormant, means V5 and V6 share one
  auth system end to end rather than V6 requiring a migration off whatever V5 shipped.
- **Database adapter: Better Auth's Drizzle adapter**, matching ADR-0014's ORM choice — one ORM,
  one migration pipeline, shared between the auth system's own tables and the rest of the
  application schema, rather than two separate data-layer stacks.

**Why a library, not hand-rolled, when this project otherwise avoids adding dependencies casually**
(ADR-0004 rejected a gateway, ADR-0013 rejected a custom LiteLLM-equivalent): authentication is
different in kind, not degree. A missing LLM failover is a reliability gap with a visible, bounded
blast radius (one run fails, visibly, per ADR-0004's own philosophy); a bug in hand-rolled password
hashing, session-fixation handling, or OAuth state validation is a security breach with an
unbounded blast radius and no visible failure mode until it's exploited. This is squarely the kind
of problem where a maintained, widely-used library is the responsible default, the same way this
project already defers to Mastra for LLM provider plumbing rather than writing its own (ADR-0003)
and to `yaml` for comment-preserving parsing rather than a bespoke parser (ADR-0007).

## Alternatives considered

| Option                                                                         | Why not                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hand-rolled session/password/OAuth implementation                              | Security-critical code with an unbounded failure blast radius; no reason to take on that risk when a maintained library exists and fits the stack.                                                                                                     |
| NextAuth/Auth.js                                                               | Historically coupled to Next.js conventions; a worse fit for a Fastify-served React SPA than a genuinely framework-agnostic library.                                                                                                                   |
| Self-hosting Keycloak or Authentik as this app's own primary identity provider | Conflates two different roles: being an IdP (what Keycloak/Authentik are) versus accepting SSO from a _customer's_ IdP (what V6 actually needs, as a relying party). This app is the relying party, not the identity provider, for its own V5 signups. |
| JWT-based stateless sessions                                                   | No multi-region/stateless-validation requirement exists for a single self-hosted backend; cookie sessions give a simpler revocation story with no offsetting benefit foregone.                                                                         |

## Consequences

- `packages/server` depends on `better-auth` and its Drizzle adapter; every hosted API route gains
  an auth/session middleware resolving the current user and active `workspace_id` — the same value
  ADR-0014's RLS policies key their tenant-scoping session variable on, meaning auth and
  multi-tenancy enforcement share one seam rather than being independently-implemented concerns
  that happen to agree by convention.
- V6's RBAC (ADR-0017) extends Better Auth's `organization`/role primitives rather than replacing
  them; V6's SSO (KAN-1122) activates the already-adopted `sso` plugin per-workspace rather than
  swapping auth systems.
- Better Auth becomes a real external dependency this project must track and upgrade — an accepted,
  bounded cost matching how ADR-0003 already accepted the same trade-off for Mastra.

## Open questions for V5 implementation to revisit

- Whether email+password requires standing up transactional email (an SMTP relay, for verification
  and password-reset emails) as new homelab infrastructure, or whether a first cut is OAuth-only
  (GitHub) to avoid that dependency entirely.
- Exact session cookie lifetime and refresh/rotation policy.
- Whether additional OAuth providers (Google, GitLab) are worth adding at V5 launch or are a
  demand-driven follow-on.
