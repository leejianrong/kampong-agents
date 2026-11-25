# Enterprise readiness

On 2026-11-24 the plan was reviewed from the seat of a skeptical enterprise buyer: a platform lead evaluating
Kampong for hundreds of non-technical staff, with a security reviewer and a team lead in tow. The review
checked what the server code does today and compared it with the public pages of competing hosted products.

The verdict was that the first version of the plan worked for a small team deploying a webhook workflow, and
that an IT lead could not sign it. It covered the author's happy path and none of the buyer's questions. The
product owner's answer is to close every gap, including single sign-on and SCIM, and to reach the readiness of
LangSmith and Langfuse Cloud. Every gap is now a card in epic KAM-E45.

> **Competitor claims are vendor-stated.** Everything in the competitor columns comes from the vendors' own
> public pages, read in November 2026, and was not independently tested. "Not verified" means the review could
> not confirm it from a fetched page. Re-check a cell before you quote it. The living version of this page is
> KAM-344.

## What the code does today

Checked in `packages/server` and `deploy/helm`:

- **Built:** Better Auth with the organization plugin mapped to workspaces; row-level security per workspace;
  AES-GCM envelope secrets under one root key; an SSRF and egress guard for tool HTTP; the deployment, runs and
  approve routes; the scheduler; Helm charts for the server and for Postgres.
- **Dormant:** the Better Auth `sso` plugin (`auth/config.ts`).
- **Not found:** an audit-log table or writer, any rate limit, any role enforcement beyond an owner check on the
  BYOK routes, usage or cost metering, an invite or member UI, and a NetworkPolicy or pod security settings in
  the chart.

## Capability matrix

| Capability               | Kampong today                    | Kampong after KAM-E45                  | LangSmith                               | Langfuse Cloud                                       | n8n Cloud                                                    | Gumloop                                      |
| ------------------------ | -------------------------------- | -------------------------------------- | --------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| SSO (OIDC, SAML)         | Plugin present, off              | OIDC then SAML (KAM-62)                | SAML and OIDC, Enterprise               | Tier-gated; tier not verified                        | SSO and LDAP on Business self-host and Enterprise; SAML not named | Enterprise, quoted price                     |
| SCIM provisioning        | None                             | SCIM 2.0 (KAM-333)                     | Enterprise                              | Tier-gated; tier not verified                        | Not verified                                                 | Enterprise                                   |
| Roles                    | Member or not                    | Four roles on every route (KAM-64, 328) | Custom roles, Enterprise                | Not verified                                         | Not verified                                                 | Not verified                                 |
| Audit log                | None                             | Every mutating route (KAM-66)          | Not stated on the page fetched          | Tier-gated; tier not verified                        | Enterprise                                                   | Enterprise                                   |
| SOC 2 and certifications | None                             | Readiness started (KAM-332)            | SOC 2 Type II, HIPAA, GDPR              | SOC 2 Type II, ISO 27001                             | Not verified                                                 | Claimed Type II; one review disagrees        |
| Data region              | One, stated honestly             | One, with a second designed (KAM-341)  | US or EU                                | US, EU, Japan and a HIPAA-ready region               | Frankfurt                                                    | Not verified                                 |
| Self-host or VPC         | Helm charts, no install guide    | Install guide (KAM-343)                | Hybrid and self-hosted                  | Not verified here                                    | Self-host on Business and Enterprise                         | VPC on Enterprise                            |
| Retention controls       | None                             | Per-workspace period (KAM-339)         | Not verified                            | Not verified                                         | 7 days, 30 days, then unlimited, by plan                     | Not verified                                 |
| Uptime SLA, status page  | None                             | Status page, preview label (KAM-330)   | Not verified                            | Not verified                                         | Dedicated SLA on Enterprise                                  | Not verified                                 |
| Approvals and review     | Persisted, resumable approvals   | Role-checked, four-eyes (KAM-327)      | Not compared                            | Not compared                                         | Not compared                                                 | Not compared                                 |
| Secrets and keys         | Per-workspace, encrypted         | Rotation and KMS (KAM-334)             | Not verified                            | Not verified                                         | External secrets on Enterprise                               | Not verified                                 |
| Egress controls          | Public addresses only, tools     | Allowlist, network policy (KAM-335, 336) | Not verified                          | Not verified                                         | Not verified                                                 | Not verified                                 |
| Usage and cost view      | None                             | Usage panel and ceilings (KAM-323, 325) | Not verified                           | Not verified                                         | Not verified                                                 | Not verified                                 |

Zapier Agents and Dify were also looked at. Zapier lists SAML and SCIM on Enterprise, keeps its SOC 2 report
under NDA and says every agent action is audit-logged. Dify lists SSO and tamper-evident audit logs with SIEM
streaming on its self-hosted Enterprise tier. Both are vendor claims.

The pattern across all of them is the same: SSO, SCIM, audit logs, custom roles, retention controls and an SLA
sit behind the Enterprise tier, and SOC 2 is expected. Kampong has none of that gate today.

## Gaps and when each must close

Gates: **first customer** is what must be true before anyone pays, **pilot** is what an enterprise needs before
a trial with real staff, and **later** is worth doing but does not block either.

| #   | Gap                                                                   | Gate           | Card(s)                 |
| --- | --------------------------------------------------------------------- | -------------- | ----------------------- |
| 1   | No rate or body-size limits on the public ingress                     | first customer | KAM-322                 |
| 2   | No quotas, spend caps or usage view                                   | first customer | KAM-323, KAM-325        |
| 3   | Roles: any member can deploy, rotate or delete                        | first customer | KAM-64, KAM-328         |
| 4   | No audit log, so deploy, rotate and delete are unattributed           | first customer | KAM-66, KAM-324         |
| 5   | Nowhere to run it; no SLA, status page or proven restore              | first customer | KAM-320, 329, 330       |
| 6   | No DPA, subprocessor list, `security.txt` or disclosure policy        | first customer | KAM-331                 |
| 7   | Model and connector calls may bypass the egress guard                 | first customer | KAM-337                 |
| 8   | Tenant isolation under concurrent runs is not tested end to end       | first customer | KAM-340, KAM-85         |
| 9   | SSO (OIDC, SAML)                                                      | pilot          | KAM-62                  |
| 10  | SCIM provisioning                                                     | pilot          | KAM-333                 |
| 11  | SOC 2 readiness                                                       | pilot          | KAM-332                 |
| 12  | One root key in a Kubernetes Secret, no KMS or rotation               | pilot          | KAM-334                 |
| 13  | No NetworkPolicy or pod security in the chart                         | pilot          | KAM-335                 |
| 14  | Per-workspace egress allowlist and documented egress IPs              | pilot          | KAM-336, KAM-65         |
| 15  | Invites, member removal and session revocation                        | pilot          | KAM-338                 |
| 16  | Traces hold prompts and outputs with no expiry or redaction           | pilot          | KAM-339                 |
| 17  | Approvers not separated from run authors on sensitive steps           | pilot          | KAM-327                 |
| 18  | Billing: manual invoicing first, Stripe later                         | first customer | KAM-346 (Stripe: KAM-86, 87, 88, later)          |
| 19  | Support channel and response targets                                  | pilot          | KAM-345                 |
| 20  | Data residency choice                                                 | later          | KAM-341                 |
| 21  | Hosted poller and synchronous replies                                 | later          | KAM-342                 |
| 22  | Self-hosted and local (minikube, k3s) install guide                   | first customer | KAM-343                 |

## Wrong or unverified claims in the first plan

These were found by the review and are corrected in this version:

- "Egress guard" is true for tool HTTP only; model and connector paths are unverified (gap 7).
- "Two replicas never fire one tick twice" was asserted without being run on two replicas.
- "Postgres with backups" meant the chart exists; no restore had been tested.
- "About 12 points" left out audit, roles, quotas, SSO and trust work. The honest total is about 151 points
  across the epic (see the [build plan](build-plan.md)).
- "Pricing is per seat, no usage columns" ignored the infrastructure cost per run and gave the customer no
  spend visibility.
- The plan did not mention billing, which AGENTS.md lists as open for V10.
- Ingress limits were scheduled last although the risk table called them a pre-signup blocker.

## Landing page

Not wanted for now. The server at `kampong.abangai.dev` is the first thing a visitor sees. The trust material
in gap 6 is still needed, and lives in the docs site until a marketing page exists. When one is built, the
review's minimum list stands: a one-line value proposition with a short demo, a data-handling summary, a trust
page with dated SOC 2 status, an availability table that marks planned features as planned, a docs link, a
waitlist form, a status link and a pricing sentence with no invented numbers.

## Sources

Read in November 2026; vendor-stated.

- Langfuse: <https://langfuse.com/security.md>, <https://langfuse.com/pricing>
- LangSmith: <https://docs.langchain.com/langsmith/enterprise>
- n8n: <https://n8n.io/pricing>
- Gumloop: <https://www.gumloop.com/enterprise>, <https://zapier.com/blog/gumloop-pricing/>
- Zapier: <https://zapier.com/security-compliance>, <https://docs.zapier.com/mcp/security>
- Dify: <https://dify.ai/pricing/dify-enterprise>
