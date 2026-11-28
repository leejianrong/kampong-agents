# Data processing agreement (draft)

**This is a draft for the operator's lawyer. It is not an agreement, it is not legal advice, and nobody should sign it
as it stands.** It is written to match what the service actually does (see [Security and data
handling](security.md) and [Subprocessors](subprocessors.md), both checked against the code on 2026-11-28), so that
legal review starts from true statements. Every `[bracketed]` item is a decision or a fact only the operator has.
Legal sign-off is the owner's (KAM-331 does not include it).

## 1. Parties and roles

- **Controller:** the customer, which decides why and how personal data in its workflows is processed.
- **Processor:** `[operator legal name, registered address]`, which runs the hosted Kampong service for the customer.

For account data (a person's name, email address and sign-in records), the operator is itself a controller. This
agreement covers the personal data that customers' workflows and members put into the service.

## 2. What is processed

| Item                       | Description                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Subject matter and purpose | Running the customer's workflows and storing their definitions, inputs, outputs, run history and audit trail, to provide the service.     |
| Duration                   | While the customer has a workspace, plus the return and deletion period in section 8.                                                    |
| Categories of data         | Whatever the customer's workflows contain: webhook payloads, documents, messages, model prompts and replies. The customer decides this.   |
| Data subjects              | The customer's own staff, customers, users and contacts, as its workflows involve them. Members' account data (name, email).            |
| Special categories         | None are intended. The customer should not put them into a workflow unless it has told the operator and the terms allow it. `[confirm]`  |

## 3. Instructions

The processor processes personal data only on the customer's documented instructions: this agreement, the customer's
use of the service, and written requests. It tells the customer if it believes an instruction breaks data protection
law.

## 4. Confidentiality

Anyone at the processor who can reach customer data is bound to keep it confidential. `[owner: confirm who has access and how it is controlled and logged]`

## 5. Security

The processor applies the measures in [Security and data handling](security.md), which form Annex A. In short: row-level
security isolates each workspace in the database, stored keys and secrets are encrypted with AES-256-GCM, outbound
requests from workflows are limited to public addresses, changes are recorded in an append-only audit log, access
follows four roles, and backups are restored on a schedule to prove they work. The same page lists what is **not** in
place (no certification, no single sign-on yet, one site, no SLA). The processor may improve measures but will not
weaken them without telling the customer.

## 6. Subprocessors

The customer authorises the subprocessors in [Subprocessors](subprocessors.md) (Annex B). The processor tells the
customer `[notice period]` before adding or replacing one, and the customer may object on reasonable grounds; if they
cannot agree, the customer may end the service and have its data returned or deleted. Model providers and connectors
that a workflow calls with the customer's own credentials are the customer's choice, not the processor's subprocessors.

## 7. Helping the customer

The processor helps the customer, as far as it reasonably can, to answer requests from data subjects, to carry out
impact assessments and to consult a regulator. Today there is no self-service export or deletion: the processor does
either on request `[owner: target time, for example 10 working days]`.

## 8. Return and deletion

On the end of the service, or on request, the processor returns the customer's data in a common format on request, and
then deletes the workspace; deletion removes its specs, runs, secrets, deployments, state and audit events. Copies in
backups expire with the backup retention, which is `[owner: confirm, the chart default is 30 days]`.

## 9. Personal data breach

The processor tells the customer without undue delay after becoming aware of a breach affecting its data, and within
`[owner: hours, for example 72]` where it can, with what it knows: what happened, which data, the likely effects and
what is being done. `[owner: name the contact the customer should give]`

## 10. Audit

The processor gives the customer the information it reasonably needs to check compliance with this agreement, and
allows an audit at reasonable notice and no more than once a year unless there has been a breach. At present there is
no independent report to share (no SOC 2, no penetration test); the customer may review the [Security and data
handling](security.md) page and the open-source code.

## 11. Transfers outside the country

`[owner: the site and country of the service, where backups are kept, and the transfer mechanism if data leaves the
customer's jurisdiction. The preview runs on one homelab site.]`

## 12. Liability, term and governing law

`[legal: liability, term, termination and governing law. Left for the lawyer.]`

## What this draft deliberately does not do

It does not promise an uptime (the preview has no SLA), a certification, or a response time the operator has not
agreed. It does not add commitments the code does not back.
