<!--
title: "An incident responder that proposes and never executes"
description: A real Prometheus and Alertmanager stack, an agent that diagnoses the failing service and asks a human to approve a fix, and the two bugs that only showed up once we left it running.
slug: incident-responder
author: Jian
date: 2026-10-02
tags: [mastra, agents, prometheus, alertmanager, slack, human-in-the-loop, kampong-agents]
-->

---

# An incident responder that proposes and never executes

The second demo is an on-call assistant. A real Prometheus and Alertmanager stack watches a small toy service, and when an alert fires the agent looks at the service's actual state, writes a diagnosis, and posts a specific proposed fix to Slack with Approve and Reject buttons.

It stops there. The agent never runs the fix. We wrote that down as a decision (ADR-0004) before building anything, because a wrong target or a wrong command has real consequences even against a toy, and "should an agent execute remediation" deserves its own design pass rather than being settled by accident in a discovery demo.

![Two live incident cards after a chaos run: ToyServiceDown (critical) and ToyServiceHighErrorRate (warning), each with a four-step tracker, the diagnosis, likely cause and proposed fix](https://raw.githubusercontent.com/leejianrong/kampong-agents/main/mastra-projects/incident-responder/docs/dashboard.png)

## The chain

Everything below runs in Docker Compose except the Node process: a toy service with a `/metrics` and a `/debug` endpoint, Prometheus scraping it, and Alertmanager forwarding alerts to a webhook on the host. A `chaos` script flips the toy service into `down`, `high_latency` or `high_errors`, so we can break it on demand and watch the real thing react.

Within about twenty seconds of `npm run chaos -- down`, two alerts fire (`ToyServiceDown` as critical and `ToyServiceHighErrorRate` as a warning). Each one goes through the same path: verify the bearer token on the webhook (Alertmanager can't sign requests the way GitHub does, so a token is the best it offers), fetch the service's debug state, and hand both to the diagnostician.

The diagnostician has exactly one tool call. It asks the service what state it's in rather than guessing from the alert text:

```ts
export async function fetchToyServiceDebug(): Promise<ToyServiceDebug> {
  const baseUrl = process.env.TOY_SERVICE_URL ?? "http://localhost:9100";
  const response = await fetch(`${baseUrl}/debug`);
  if (!response.ok) {
    throw new Error(`toy-service /debug returned HTTP ${response.status}`);
  }
  return (await response.json()) as ToyServiceDebug;
}
```

That one call is why the diagnosis is any good. Given only the alert, a model says "investigate the service". Given the chaos mode, when it changed and the last thirty requests (all failing in 20 to 50ms), it says the service is in an injected `down` mode, not overloaded, and proposes clearing the mode. The prompt also bans vague advice, so the proposal has to be something a human could do right now.

## Bug one: Slack couldn't verify its own button

Approve and Reject are Slack interactive buttons, and Slack needs a public HTTPS URL to send clicks to. Again smee.io, again a local forwarder. The first click came back 401.

The reason is that Slack signs the exact bytes of a form-encoded body, and smee re-sends it as JSON, so the bytes we verify are never the bytes Slack signed. The fix is to rebuild the original body from the parsed payload, encoded the way Slack encodes it (strict RFC 3986, spaces as `+`), and then run the normal HMAC check against that:

```ts
function recoverSlackRawBody(body: unknown): string {
  if (typeof body === "string") return body;
  const payload = (body as { payload?: unknown } | null)?.payload;
  if (typeof payload !== "string") return "";
  const strict = encodeURIComponent(payload).replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return "payload=" + strict.replace(/%20/g, "+");
}
```

The signature check stays fully on, which I care about. The shortcut would have been to skip verification for relayed requests, and that's the kind of shortcut that quietly ships.

## Bug two: five minutes later, the same incident again

This one only appeared because we left the demo running. Alertmanager re-notifies every still-firing alert each `repeat_interval` (five minutes in our config). Our first version treated every notification as a new incident, so it re-ran the diagnosis, posted another Slack proposal and appended another block to the same card. After a while one card was a screenful of near-identical diagnoses, and the Slack channel had a stack of proposals for a problem someone had already approved a fix for.

The fix is a single line, keyed on the alert's fingerprint:

```ts
if (openIncidents.has(incidentId)) continue;
```

A repeat of an open incident is the same incident. It's obvious in hindsight, but a demo that fires one alert and gets screenshotted would never have shown it. Anything in kampong that triggers from Alertmanager will need the same rule.

## What it says about kampong-agents

The good news is that the approval half needed almost nothing new. The Slack button pattern we shipped in the product (KAN-1432) carried over with a rename.

What didn't carry over is the shape of the approval. kampong's human-in-the-loop primitive pauses a run and waits. Here nothing is waiting: the diagnosis and the proposal are already finished by the time a person sees them, and the click records a decision on work that's complete. Whether the primitive should cover "notify and record" as well as "pause and wait" is a real schema question.

Two more entries for the list. The map of open incidents lives in memory, so a restart during an incident loses the link to the Slack message someone is about to click. And the open question from ADR-0004 stays open: if an agent should ever execute an approved fix, it needs an allow-list, a scoped target and a dry run, and that's a design of its own.
