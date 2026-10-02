# Findings: what five real demos say kampong-agents is missing

Slice 6 of the `mastra-projects/` discovery initiative. Each gap below comes from
a specific demo's gap-analysis section (README) and was hit while running that
demo against real services (ADR-0001). Nothing here is hypothetical.

Demos: **PR** = `pr-review-swarm/`, **IR** = `incident-responder/`,
**ST** = `support-triage/`, **RA** = `research-analyst/`, **ETL** = `market-etl/`.

Effort: **S** = days, **M** = 1–2 weeks, **L** = multi-week with design work.

## Ranked gaps

Ordered by value: demos needing it, then effort, then whether the gap blocks a whole class of agent.

| # | Gap | Demos | Count | Effort | Roadmap entry |
|---|-----|-------|-------|--------|---------------|
| 1 | No non-webhook trigger shapes (`schedule`, `poll`) | ETL, ST | 2 | M | Epic F1 |
| 2 | `knowledge_base` is declared but inert; no retrieval, no embeddings story | RA, ST | 2 | L | Epic F2 |
| 3 | Slack HITL plumbing: needs a public URL, relay breaks signing, Socket Mode silently disables HTTP, one Interactivity URL per app | IR, ST | 2 | S–M | Epic F3 |
| 4 | Durable run state: a pending approval or open incident lives in process memory and is lost on restart | IR, ST | 2 | M | Epic F4 |
| 5 | Inbound webhook auth differs per source (GitHub HMAC, Slack HMAC, Alertmanager bearer, none for polls) | PR, IR, ST | 3 | S | Epic F5 |
| 6 | Gmail connector is send-only (no list, get, draft, label) | ST | 1 | M | Epic F6 |
| 7 | `http_request` cannot detect failure in a 200 body, and has no pacing or backoff | ETL | 1 | S–M | Epic F7 |
| 8 | `sub_agents` fan-out / fan-in (planner delegates to N specialists, merge) | PR | 1 | L | Epic F8 |
| 9 | HITL "record a decision after the fact" vs. "pause and wait" | IR | 1 | M | Epic F9 |
| 10 | Agent-executed remediation after approval (ADR-0004) | IR | 1 | L | Epic F10 |
| 11 | Exact version pinning of `@mastra/core` / `@ai-sdk/*` in generated projects | PR | 1 | S | Epic F11 |

Gap 5 has the highest raw count (3) but is mostly documentation plus a per-source
auth setting, so it is a quick win rather than the top roadmap item. Gaps 1 and 2
change what kinds of agent a kampong user can build at all, so they lead. PR and
ST hit HMAC verification in practice; only IR wrote the cross-source point down in
its README.

## Detail

### 1. Schedule and poll triggers (ETL, ST)
Every shipped trigger is a chat turn or a webhook. ETL needs "run on a timer with
no event to key off"; ST needs "loop on an inbox, one run per new message". Both
are a different execution shape from a request/response. `kampong dev` and
`kampong run` are interactive-first; nothing in `packages/cli` starts an
unattended loop. Open question from ETL: is a no-HITL background job in scope for
`AgentSpec` at all, or a deliberate v1 boundary? These demos say it should be in
scope. Needs: a `trigger` variant (`schedule: cron`, `poll: {source, interval}`),
a long-running runner mode in the CLI, and dedupe state (see gap 4).
ETL also ran the no-approval path end to end, so omitting `requires_approval`
already covers the "no HITL" half.

### 2. `knowledge_base` is inert (RA, ST)
`AgentSpec.knowledge_base` (`pdf | url | text`) is never read by the engine; the
docs say "declared, not yet executed". RA built the real thing (chunk, embed,
pgvector, cited answer) from scratch. ST hit the same wall from the other side:
without a product FAQ in the prompt the classifier could not reach confidence on
a password-reset ticket and escalated everything; with the FAQ it auto-drafted at
0.92–0.95.
Design points RA surfaced: static injection and per-query retrieval are
different capabilities and the spec should say which; OpenRouter has no
embeddings endpoint, so a BYOK second key or a bundled local model must be chosen
explicitly; plain cosine search missed the obvious ADR on a short specific
question, so hybrid search or query rewriting is needed; chunking must be
sentence-aware.

### 3. Slack HITL plumbing (IR, ST)
The approval-button pattern (KAN-1432) works, but running it locally is brittle:
- Slack needs a public HTTPS Request URL; there is no local-only path.
- smee.io re-sends the form-encoded click as JSON, so Slack's HMAC can never
  verify on the relayed body. ST fixes it by rebuilding `payload=` + RFC 3986
  encoding (`recoverSlackRawBody`), keeping the signature check fully on.
- Socket Mode ON silently stops HTTP interactivity delivery. No error anywhere.
- One Slack app has one Interactivity URL, so concurrent HITL workflows (and V5
  multi-tenant hosting) need a router or per-workflow apps.
Needs: setup docs, a first-party tunnel or relay story for `kampong dev`, and a
decision on routing for hosted mode.

### 4. Durable run state (IR, ST)
IR's `openIncidents` and ST's ticket map are in memory. A restart orphans the
Slack message the human is about to click. Any workflow that outlives a process
needs persisted run state. Also the substrate for poll dedupe (gap 1).

### 5. Per-source webhook auth (PR, IR, ST)
GitHub and Slack sign with HMAC; Alertmanager only offers a bearer token; polls
have no inbound request. KAN-1436's ingress should document and configure auth
per source rather than assume one scheme.

### 6. Gmail connector (ST)
`gmail_send` is the only operation, built on a pre-minted bearer token that
cannot drive an ongoing poll. ST used IMAP plus an App Password. A triage spec
needs list-unseen and create-draft actions and a long-lived credential story
(OAuth2 refresh token or IMAP). The Drafts folder is locale-dependent; use the
`\Drafts` special-use flag.

### 7. `http_request` failure detection and pacing (ETL)
Alpha Vantage reports rate limits and errors as 200 bodies (`Note`,
`Information`, `Error Message`). `http-tool.ts` checks status only, so a
rate-limited call looks like success. A real run also tripped the 1 req/s burst
limit because nothing paces calls. Needs a configurable failure-detection rule
(JSON path / body matcher) and per-tool pacing and backoff.

### 8. `sub_agents` fan-out (PR)
v1 is single-agent (ADR-0001). The swarm needs routing (static list or
planner-decided), a fan-out/fan-in shape distinct from linear or conditional
workflows, and per-sub-agent instructions and model without duplicating the spec
schema. Already a reserved field; PR gives it concrete requirements.

### 9. HITL: record vs. pause (IR)
KAN-1432 HITL pauses a run. IR's approval is a recorded decision on work that is
already complete. ST sits in between (escalate, then draft on approve). Decide
whether the primitive supports "notify and record" as a first-class mode.

### 10. Remediation execution (IR, ADR-0004)
Explicit entry per ADR-0004. IR stops at a proposed fix plus approval; nothing
executes. Open question: should kampong support agent-executed remediation after
approval, and with what allow-list, target scoping, dry-run, and audit trail? It
carries a real safety surface and depends on gaps 3, 4 and 9, so it is
deliberately last. Recommendation: do not start until those land; scope the first
version to a small declared allow-list of actions.

### 11. Exact version pinning (PR)
`@mastra/core` and `@ai-sdk/*` are not semver-safe against each other: caret
ranges resolved a pair that failed typechecking (`LanguageModelV4` mismatch).
The exporter should emit exact pins matching `packages/engine`. Related gotcha
already known to the engine: OpenRouter and Ollama need `.chat(name)`, not the
Responses API default.

## Not gaps (confirmed working)
- Guardrail/HITL escalation half of ST needed zero changes (only a rename).
- "No approval" workflows are already expressible by omitting `requires_approval`.
- Fail-visibly on provider errors held up in real runs (ETL hard-failed a
  rate-limited symbol and wrote no partial row).

## Traceability
Every gap maps to the "Gap-analysis" section of at least one demo README:
PR (8, 11, 5), IR (3, 4, 5, 9, 10), ST (1, 2, 3, 4, 5, 6), RA (2), ETL (1, 7).

## Calibration TODOs (not gaps)
Classifier confidence calibration (ST), planner routing quality (PR),
diagnostician specificity under `high_latency` (IR), summarizer tone on a real
volatile move (ETL). Revisit with more real traffic.
