# Mastra demos: Slices

Five vertical slices, one per demo, each independently demonstrable. No slice
depends on a later one. Ordered riskiest-mechanism-first (Slice 1), then by
how directly each tests kampong-agents' already-shipped features, ending with
the slice that consolidates findings back into the kampong-agents roadmap.

## V1: PR-review swarm (`pr-review-swarm/`)

**Delivers:** R0, R1, R5, R6, R7 — done. Model calls go through OpenRouter
(ADR-0005); a live "swarm map" + event feed dashboard is served at `/`
(ADR-0006).

**Build plan**

1. Create a small, dedicated sandbox GitHub repo (real, throwaway toy
   codebase) to open real PRs against (ADR-0003).
2. Build a Mastra multi-agent pipeline: a planner agent that triages an
   incoming PR diff and delegates to specialist sub-agents (security review,
   style review, test-coverage review), then merges their findings into one
   real review comment posted via the GitHub API.
3. Wire a real GitHub webhook (PR opened/synchronize) to trigger the pipeline.
4. Run it against a handful of real PRs with deliberately varied content
   (a real security-relevant change, a real style nit, a real missing-test
   case) to see the delegation pattern actually exercised.
5. Write the gap-analysis: what would it take to express "planner delegates
   to N specialist sub-agents, merge their outputs" as a kampong `AgentSpec`
   today, given v1 is single-agent-only (ADR-0001 in the main product).

**Demo:** open a real PR against the sandbox repo; watch the real webhook
fire, the pipeline run, and a real multi-part review comment land on the PR.

**Rests on assumptions:** Q4 (outside the npm workspace) — if wrong, this
demo would need to be re-tooled into the workspace, which is mechanical, not
a design change.

### Test plan

#### End-to-end

- Opening a real PR against the sandbox repo results in a real review comment
  containing output from all three specialist sub-agents within a bounded
  time window.

#### Integration

- The planner correctly routes a PR diff to the specialist(s) whose concern
  it actually touches (verified against a handful of real, varied PRs, not
  synthetic diffs).

#### Unit

- Diff-parsing and prompt/tool-schema construction logic (no network).

## V2: Incident responder (`incident-responder/`)

**Delivers:** R0, R1, R4, R5, R6, R7

**Build plan**

1. Stand up a small real toy service plus a real, self-hosted
   Prometheus + Alertmanager stack (docker-compose) monitoring it
   (ADR-0003).
2. Wire Alertmanager's real webhook output into a Mastra agent (this is the
   same webhook-ingress mechanism kampong-agents just shipped — KAN-1436 —
   so this demo doubles as a stress test of that feature outside the
   product).
3. Build the agent's real diagnosis step: tool calls that inspect the toy
   service's actual state (logs, real health-check endpoint, real recent
   error rate).
4. Build the real proposed-remediation step: agent posts a specific fix
   proposal to Slack and waits for real human approval — and stops there
   (ADR-0004). No execution path is built.
5. Inject a real failure (kill a real dependency, induce real latency) and
   confirm the full real chain: alert fires → diagnosis runs → proposal
   posted → approval requested.
6. Write the gap-analysis, explicitly including the deferred
   execute-after-approval question as a named `FINDINGS.md` roadmap item.
7. Model calls through OpenRouter (ADR-0005); serve a real-time dashboard
   (ADR-0006) with a signature timeline: alert → diagnosis → proposal →
   approval, sharing `pr-review-swarm/`'s `tokens.css` verbatim.

**Demo:** kill the toy service's real dependency; watch a real Prometheus
alert fire, the agent diagnose it for real, and a real Slack message appear
asking for approval on a specific proposed fix.

**Rests on assumptions:** none beyond PLAN's global assumptions.

### Test plan

#### End-to-end

- Injecting a real failure results in a real Alertmanager webhook, a real
  diagnosis referencing the actual failure, and a real Slack approval
  request, all within a bounded time window.

#### Integration

- The webhook handler correctly parses real Alertmanager payloads across at
  least two distinct real alert types (dependency-down, latency-spike).

#### Unit

- Alert-payload parsing and remediation-proposal formatting logic (no
  network).

## V3: Support triage (`support-triage/`)

**Delivers:** R0, R1, R5, R6, R7

**Build plan**

1. Create the dedicated real Gmail inbox for this demo (ADR-0003).
2. Build a Mastra agent that polls the real inbox, classifies incoming real
   email as a support ticket, drafts a real reply, and escalates
   low-confidence cases to a human via the existing real Slack
   approval-button pattern from KAN-1432.
3. Send the inbox a handful of real test emails spanning "confidently
   answerable" and "needs a human" cases.
4. Write the gap-analysis against kampong's existing guardrail/HITL support,
   since this is the demo closest to what's already shipped — the
   interesting finding is *how close* it gets, not whether it's possible at
   all.
5. Model calls through OpenRouter (ADR-0005); serve a dashboard (ADR-0006)
   with a signature triage board: inbox → classification → draft/escalate.

**Demo:** send a real email to the dedicated inbox; watch the agent draft a
real reply for a clear-cut case, and post a real Slack approval request for
an ambiguous one.

**Rests on assumptions:** Q7 (dedicated Gmail inbox, not the user's personal
one) — if wrong, swap the binding, no design change.

### Test plan

#### End-to-end

- A real "clearly answerable" email gets a real drafted reply without human
  intervention; a real "ambiguous" email produces a real Slack approval
  request instead.

#### Integration

- Gmail polling correctly identifies new real messages without
  re-processing ones already handled.

#### Unit

- Ticket-classification prompt construction and confidence-threshold logic
  (no network).

## V4: Research analyst (`research-analyst/`)

**Delivers:** R0, R1, R5, R6, R7

**Build plan**

1. Provision a real Supabase Postgres project with pgvector enabled
   (ADR-0003).
2. Ingest kampong-agents' own real `docs/`/ADRs, chunk and embed them, and
   store the real vectors in Supabase.
3. Build a Mastra RAG agent that answers real questions with citations back
   to the real source documents.
4. Ask it a handful of real questions about kampong-agents (including at
   least one whose answer requires synthesizing across more than one real
   document).
5. Write the gap-analysis against kampong's "knowledge references" spec
   field — does it actually support real retrieval-with-citations, or just
   static context injection.
6. Model calls through OpenRouter (ADR-0005); serve a dashboard (ADR-0006)
   with a signature retrieval trace: question → matched chunks → cited answer.

**Demo:** ask the agent a real question about kampong-agents' architecture;
get back a real answer with citations to the real ADRs/docs it drew from.

**Rests on assumptions:** none beyond PLAN's global assumptions.

### Test plan

#### End-to-end

- A real multi-document question returns an answer that correctly cites more
  than one real source document.

#### Integration

- Retrieval against the real Supabase pgvector store returns the actually
  relevant chunk(s) for a fixed set of real known-answer questions.

#### Unit

- Chunking and citation-formatting logic (no network).

## V5: Market ETL (`market-etl/`)

**Delivers:** R0, R1, R5, R6, R7

**Build plan**

1. Build a scheduled job that pulls real market data from the Alpha Vantage
   API for a small fixed set of real tickers.
2. Transform/validate it and load it into a real Supabase Postgres table.
3. Add real anomaly detection (e.g. a real price move beyond a fixed
   threshold) over the real ingested data.
4. On a real detected anomaly, send a real Slack summary — no human
   approval gate, since this demo deliberately tests the fully-autonomous,
   no-HITL end of the spectrum.
5. Write the gap-analysis against kampong's execution model: does anything
   in the current `AgentSpec`/CLI support a scheduled, no-human-in-the-loop
   background job at all, or is everything implicitly chat/webhook-triggered.
6. Model calls through OpenRouter (ADR-0005); serve a dashboard (ADR-0006)
   with a signature ingestion strip: pull → validate → anomaly flag.

**Demo:** trigger a real run against real market data; see real rows land in
Supabase, and (using a deliberately sensitive threshold for the demo) a real
Slack anomaly summary get posted.

**Rests on assumptions:** none beyond PLAN's global assumptions.

### Test plan

#### End-to-end

- A real scheduled run against real market data produces real rows in
  Supabase and a real Slack message when the anomaly threshold is crossed.

#### Integration

- Alpha Vantage API errors/rate limits are surfaced as a hard, visible
  failure (per PLAN's Implementation decisions), not silently dropped.

#### Unit

- Anomaly-threshold and data-validation logic (no network).

## V6: Findings and roadmap feedback

**Delivers:** R2, R3

**Build plan**

1. Pull each demo's README gap-analysis section into one place.
2. Write `mastra-projects/FINDINGS.md`: a table of discovered gaps, how many
   of the 5 demos needed each one, and a rough effort-to-close estimate —
   including the `incident-responder/` remediation-execution question from
   ADR-0004 as an explicit entry.
3. Turn the highest-ranked findings into concrete new/updated entries in
   kampong-agents' root `SLICES.md` and/or the Pandan board (one epic per
   accepted finding, following the existing "one epic per slice" convention).

**Demo:** `mastra-projects/FINDINGS.md` exists, ranks gaps by demo-count and
effort, and at least a handful of its items are visible as real entries in
the root `SLICES.md` or on the Pandan board.

**Rests on assumptions:** none — this slice only depends on V1–V5 already
being built.

### Test plan

#### End-to-end

- `FINDINGS.md` exists and every gap it lists traces back to at least one
  specific demo's gap-analysis section.

#### Integration

- n/a (this slice produces documentation and backlog entries, not code).

#### Unit

- n/a.
