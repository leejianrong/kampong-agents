# Subprocessors

A subprocessor is a company that handles customer data on our behalf. This is the list for the hosted preview, checked
against the code and the deployment on **2026-11-28**. The operator keeps it current and tells customers before a
change (the notice period is in the [data processing agreement](dpa.md)).

## Who handles customer data today

| Who                                  | What they handle                                                                  | Where                  | Status                           |
| ------------------------------------ | --------------------------------------------------------------------------------- | ---------------------- | -------------------------------- |
| The operator's homelab (k3s cluster) | Everything the service stores: the database, the running server, its logs         | `[owner: site and country]` | In use; a single site          |
| The backup bucket host               | Encrypted-in-transit copies of the database and its WAL (see the restore runbook) | `[owner: provider and region]` | **Not yet chosen** for the real install |
| GitHub                               | The source code and this documentation. No customer data.                         | United States          | Not a subprocessor of customer data |

The table's two bracketed cells are the operator's to fill before a first customer: the physical site and country of
the homelab, and the bucket provider and region. They cannot be read from the code.

## Not subprocessors of ours

- **Model providers.** A workflow calls the provider the customer chose (OpenRouter, OpenAI, Anthropic, a local
  Ollama) with the customer's **own** key. What the provider receives and keeps is between the customer and that
  provider, under its terms. We do not hold a key of our own for them, send nothing on a customer's behalf that the
  workflow did not ask for, and add no provider to a workspace.
- **Connectors a workflow uses** (Slack, Gmail, GitHub, Supabase and the like). Same: the customer's credentials, the
  customer's choice, called only when the workflow runs.

## What is absent, on purpose

The server sends **no email**, runs **no analytics or error-reporting service** and calls **no third party** on its own
(checked in `packages/server/package.json` and the source). There is no payment processor: invoicing is manual.

## Changes

A new subprocessor is added to this page before it handles customer data, and customers who have a data processing
agreement are told at least `[owner: notice period, for example 30 days]` ahead.
