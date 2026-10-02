<!--
title: "What five Mastra demos taught the kampong-agents roadmap"
description: We built five real agent workflows to find the gaps in kampong-agents. Here is the ranked list, what we think should come first, and what we're deliberately leaving alone.
slug: what-five-demos-taught-the-roadmap
author: Jian
date: 2026-10-02
tags: [mastra, agents, roadmap, kampong-agents, findings]
-->

---

# What five Mastra demos taught the kampong-agents roadmap

We built five small agent workflows on Mastra against real services, with nothing mocked, and kept notes on every place kampong-agents' spec couldn't have described them. The write-ups are here: [[Three reviewers, one comment: a PR review swarm on Mastra]], [[An incident responder that proposes and never executes]], [[The FAQ that fixed our support triage classifier]], [[RAG over our own docs, and the ADR it missed]] and [[A rate limit that returns 200 OK]]. This post pulls the notes together into a list we can act on.

The full version lives in `mastra-projects/FINDINGS.md` in the repo, and each finding is a roadmap epic on our board. Here's the short version, with opinions.

## The list

| # | Gap | Demos that hit it | Effort |
|---|---|---|---|
| 1 | No schedule or poll triggers | market-etl, support-triage | medium |
| 2 | `knowledge_base` declared but never executed | research-analyst, support-triage | large |
| 3 | Slack approval is hard to run locally | incident-responder, support-triage | small to medium |
| 4 | Run state is lost on restart | incident-responder, support-triage | medium |
| 5 | Webhook auth differs per source | pr-review-swarm, incident-responder, support-triage | small |
| 6 | Gmail connector only sends | support-triage | medium |
| 7 | `http_request` can't spot failure in a 200 body, and doesn't pace | market-etl | small to medium |
| 8 | `sub_agents` fan-out and merge | pr-review-swarm | large |
| 9 | Approval as a recorded decision, not only a pause | incident-responder | medium |
| 10 | Agent-executed remediation after approval | incident-responder | large |
| 11 | Exact version pinning in exported projects | pr-review-swarm | small |

Effort is a rough guess in days to weeks, and it isn't the same thing as importance, so the order below is the order I'd actually do things in.

## What I'd do first

**Triggers (1).** This is the biggest gap and the one that changes what you can build. Two demos needed something other than a chat turn or a webhook: market-etl wants a timer and support-triage wants an inbox poll. A poll is the harder of the two, because there's no inbound request to start a run, just a loop finding work, and it needs to remember what it has already seen. That memory is gap 4 in disguise, so I'd design them together.

**The quick ones (5, 7, 11).** Per-source webhook auth, failure detection inside a 200 body and exact version pins are each a few days of work, and each one removed a real failure from a real run. Alpha Vantage's rate limit reading as success, and a fresh `npm install` that stops typechecking, are the sort of thing that costs a new user an afternoon and their trust. These are cheap and I'd just do them.

**Slack approval (3).** Mostly documentation and one decision. Socket Mode silently stops clicks reaching an HTTP endpoint, a relay that rewrites the body breaks the request signature, and Slack needs a public URL that a laptop doesn't have. We fixed each of these by hand in two demos. `kampong dev` should either ship a tunnel story or say clearly that approval needs one.

## What comes next, and why it's harder

**`knowledge_base` (2).** It's the most visible gap, because the field exists and does nothing, which is worse than not having it. It's also the largest piece of work in the first half of the list. Static injection and per-query retrieval are two different features, an embeddings provider has to be chosen (OpenRouter has none), and plain vector search missed the ADR we asked about directly. I'd rather ship an honest "not executed" warning soon and build retrieval properly than rush a version that cites the wrong document.

**The Gmail connector (6).** Needs list, get and draft, and a long-lived credential. IMAP with an app password was enough for the demo, and OAuth2 is what a real product would want. Worth doing once triggers exist, because without a poll trigger a list action has nothing to run it.

**Recorded decisions (9).** Our approval primitive pauses a run. The incident responder's approval records a decision on work that has already finished. I'd settle this before adding any more approval flavours.

## What I'd leave alone for now

**Sub-agents (8)** overlaps with the V7 orchestration work and needs a real design on routing and fan-in. The swarm demo gave us concrete requirements, and one run isn't enough evidence to start a schema.

**Agent-executed remediation (10)** is the one I'd hold back on purpose. The incident responder deliberately proposes and never runs anything (ADR-0004), and building execution would depend on three other gaps (Slack plumbing, durable state and recorded decisions) being in place first. When we do get there, I'd start with a small declared allow-list of actions and nothing wider.

## What the demos did well

Not everything was a gap. The escalation half of support triage needed no code changes beyond a rename, so the approval model is a good fit for the shape of problem it was built for. Leaving out `requires_approval` already expresses "no human", and market-etl ran that way without complaint. And the "fail visibly, don't fall back silently" rule held up: a rate-limited ticker failed on its own, wrote no partial row and let the rest of the run finish.

The pattern across all five is that the happy path was never where the trouble was. Every real problem came from something a mock would have hidden: a body that was rewritten in transit, a project paused for inactivity, an alert that repeats every five minutes. That's why we built them this way, and I'd do the next batch of demos the same way.
