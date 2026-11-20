# ADR-0064: Traces are stored in Postgres first, behind a store interface

- Status: Proposed (needs a measurement run before it is Accepted; see "What is not measured")
- Date: 2026-11-20
- Deciders: Jian (product owner); drafted by the agent working KAM-254

## Context

ADR-0063 makes tracing, dashboards and evals part of the product, so spans (and later spans ingested from outside
agents) must be stored and queried. The choice that matters is between Postgres, which the hosted server already
runs under row-level security (ADR-0014, ADR-0013), and a columnar store such as ClickHouse. It decides how heavy a
self-host install is (the enterprise north star) and what a trace costs to keep.

Facts we have:

- The hosted server is Postgres with FORCE row-level security keyed on `app.workspace_id`. Every table a workspace
  owns is protected the same way, and `withWorkspaceScope` is the only way in. A second store would need its own
  tenant isolation, tested the way the RLS suite tests Postgres (KAM-61).
- Langfuse, the closest open-source reference, stores traces in ClickHouse with blob storage for large payloads;
  that is what makes its self-host heavy. That is a statement about its design at its scale, not a measurement of
  ours.
- A Kampong run produces a handful to a few hundred spans (steps, model calls, loop iterations). The first buyer
  runs agents for teams, not consumer-scale traffic.

## Decision

1. **Postgres is the v1 trace store.** Spans live in a `spans` table, scoped by `workspace_id` under the same FORCE
   RLS as `runs`, partitioned by month on start time so retention (ADR-0065) is dropping a partition, not a bulk
   delete. A run's `trace_json` column stays for the existing run view until the span tables replace it.
2. **All access goes through a `TraceStore` interface** (write a trace, read one, list and aggregate by workflow and
   time range). Dashboards (KAM-259) and the run view (KAM-258) depend on the interface, never on SQL. Local mode
   implements it in memory (and later SQLite); hosted implements it on Postgres.
3. **Aggregates are computed in Postgres with covering indexes and, if needed, rollup tables** (per workflow per
   hour: run count, failures, token and cost sums, latency histogram buckets). We do not scan raw spans for a
   dashboard.
4. **Large payloads stay out of the row.** Prompts and outputs, when a workspace opts in to keeping them
   (ADR-0065), go in a separate table (later object storage), so the span table stays narrow.
5. **A columnar store is added only when a trigger is hit,** not before. The triggers are: a dashboard query over
   the retention window exceeds a latency budget we set when KAM-259 ships (proposed: p95 over 2 seconds at the
   largest workspace), or sustained span ingest from outside agents (KAM-267) exceeds what one Postgres primary
   absorbs with the batching in decision 6. Moving then means a second implementation of `TraceStore`, a backfill
   and a per-workspace tenant-isolation suite. The ADR that adds it supersedes this one.
6. **Ingest is batched.** A run's spans are written in one insert at run end (and at each approval pause), and the
   OTLP ingest endpoint buffers and writes in batches. One row per span insert is not the design.

## What is not measured

This ADR is Proposed because the spike's measurements were not run. The agent working it had no Postgres or
ClickHouse available. Nothing above claims a throughput figure. Before this is Accepted, run on a Postgres sized like
the Helm chart's default (CloudNativePG, KAM-51):

- Insert: batched span inserts at 100, 1,000 and 5,000 spans per second sustained for 10 minutes; record p95 write
  latency and WAL growth.
- Query: the five dashboard queries (runs per hour, failure rate, cost per workflow per day, latency p50/p95,
  slowest steps) over 10 million, 100 million and 500 million spans, with RLS on, with and without a rollup table.
- Footprint: the idle and loaded memory, disk per million spans (with indexes), and the backup size.

The result sets the volume this ADR claims to handle and the latency budget in decision 5.

## Consequences

- The self-host story stays one database (Postgres) plus the app, which is the lightest the enterprise buyer can get.
- Tenant isolation is the existing, already tested RLS; the cross-tenant suite grows a `spans` case (KAM-257).
- Very high volume (an outside platform sending millions of spans a day into one workspace) is the case this
  decision handles worst. It is deliberately deferred behind the interface rather than solved now.
- KAM-257 (hosted span storage) builds decisions 1, 2 and 6.
