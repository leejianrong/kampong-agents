<!--
title: "The FAQ that fixed our support triage classifier"
description: A Gmail inbox, a classifier that drafts replies, and a Slack approval for the ones it isn't sure about. The surprise was how much a short product FAQ mattered, and how many ways Slack clicks can silently go nowhere.
slug: support-triage
author: Jian
date: 2026-10-02
tags: [mastra, agents, gmail, imap, slack, human-in-the-loop, kampong-agents]
-->

---

# The FAQ that fixed our support triage classifier

The third demo is the one closest to what kampong-agents already ships, so the interesting question was how close it gets. A dedicated Gmail inbox is polled every thirty seconds. A classifier agent reads each new email, picks a category, writes a complete draft reply and scores its own confidence. If the score clears the threshold (0.7 by default) the draft goes straight into the Gmail Drafts folder. If it doesn't, the ticket is escalated to Slack with Approve and Reject buttons.

![The support-triage board: a password-reset ticket auto-drafted at 0.96 confidence under Done, and a billing dispute escalated at 0.20 confidence awaiting a human](https://raw.githubusercontent.com/leejianrong/kampong-agents/main/mastra-projects/support-triage/docs/dashboard.png)

## IMAP instead of the Gmail API

The Gmail REST API wants an OAuth2 installed-app flow (a Cloud Console project, a consent screen, a desktop client, a refresh token) before a headless process can poll anything. Every other credential in these demos was one step, generate and paste. So this demo uses IMAP with a Gmail App Password, which takes 2-Step Verification and one settings page.

That's a trade-off a real kampong Gmail connector would have to make on purpose. It's also why the existing connector can't do this at all: `gmail_send` builds one message from a pre-minted bearer token and posts it, and a token minted for one call can't drive a polling loop. There's no list, no get, no draft anywhere in the product.

One IMAP detail worth knowing: the Drafts folder is `[Gmail]/Drafts` only when the account's interface is in English. The reliable way to find it is the `\Drafts` special-use flag.

## The classifier couldn't be confident about anything

The classifier returns a category, a confidence between 0 and 1, a one-sentence reason and a full draft reply (even when confidence is low, since a human reviewing an escalation wants a starting point). Its instructions lean conservative on purpose: anything about billing, refunds, an angry customer or an account change needing identity checks should score well under 0.7.

The first version escalated everything, including "how do I reset my password?". It had no way to know how password resets work in our product, so any answer was a guess, and a well-calibrated model scores a guess low. The behaviour was correct and the demo was useless.

The fix was giving it facts. A short product FAQ went into the system prompt (reset a password, change an email, export data, support hours), along with a rule that a question answered by the FAQ gets high confidence and should quote the steps instead of inventing any. I also narrowed the "account access means low confidence" rule to changes that need identity verification, because it had swallowed ordinary password resets.

After that the password reset auto-drafts at 0.92 to 0.96, and the billing complaint ("You charged me twice and nobody is helping") still escalates at 0.20, with the reason spelled out for the reviewer: duplicate charge, refund request, no order number, an angry sender threatening a bank dispute.

This is the same gap the research-analyst demo hit from the other side. kampong's spec has a `knowledge_base` field, but nothing in the engine reads it. A triage agent built from a spec today would have no product knowledge at all, and it would behave exactly like our first version.

## Why the Approve click went nowhere

Getting the escalation to Slack was easy. Getting the click back took two separate fixes, and neither one produced an error.

First, the Slack app had Socket Mode switched on. In that mode Slack delivers interactions over a websocket and never makes an HTTP request, so our `/slack/interactions` endpoint sat there waiting. Nothing logged, nothing failed. Turning Socket Mode off and setting the Interactivity URL fixed that.

Second, once clicks were arriving through smee.io they failed signature verification, because smee turns Slack's form-encoded body into JSON and the bytes Slack signed are gone. We rebuild the original body from the parsed payload and verify the real HMAC against it (the same trick as in the incident responder demo).

After both, a click returned 200, a `human_decision` event fired, a real draft appeared in Gmail and the Slack message updated to say so.

## What it says about kampong-agents

The escalation half needed no changes. The Slack approval code moved over with one rename, `incidentId` to `ticketId`, so the guardrail and approval model is a good fit.

The gap sits before it. Nothing in the spec says "poll an inbox on an interval and start one run per new message". Today's triggers are a chat turn or a webhook, and a poll is a different shape because there's no inbound request to key a run off, just a loop discovering work. It needs somewhere to remember what it has already handled, too (our ticket map lives in memory, so a restart loses pending escalations).

Slack approval also has no local-only path. It needs a public URL, so even a laptop demo needs a tunnel, and a tunnel that rewrites the body breaks the signature. A hosted kampong gets a public URL for free. Local `kampong dev` needs a documented answer.
