<!--
title: "Three reviewers, one comment: a PR review swarm on Mastra"
description: A planner agent reads a real pull request, picks which of three specialist reviewers should look at it, and posts one merged review. What it took, and what it says about multi-agent support in kampong-agents.
slug: pr-review-swarm
author: Jian
date: 2026-10-02
tags: [mastra, agents, github, webhooks, multi-agent, kampong-agents]
-->

---

# Three reviewers, one comment: a PR review swarm on Mastra

This is the first of five small demos we built to find out what kampong-agents can't express yet. The rules were simple: everything is real (a real GitHub repo, real webhooks, real model calls through OpenRouter) and nothing is mocked. If a demo only works against a fake, it tells us nothing about the product.

The first one reviews pull requests. Open a PR on a sandbox repo and a planner agent reads the diff, decides which of three specialists (security, style, test coverage) are worth waking up, runs them in parallel, and posts one merged comment.

![The pr-review-swarm dashboard after a real PR: the planner routed to security, style and test-coverage, which returned 5, 1 and 1 findings, merged into one posted review](https://raw.githubusercontent.com/leejianrong/kampong-agents/main/mastra-projects/pr-review-swarm/docs/dashboard.png)

## The shape

The planner is a small Mastra agent that returns structured output, a list of specialist names. Its instructions end with the line that matters most: only pick a specialist if the diff plausibly touches their concern, because routing everything to everyone defeats the point.

```ts
export async function planReview(diff: string, files: string[]) {
  const prompt = `Files changed:\n${files.join("\n")}\n\nDiff:\n${diff}`;
  const result = await plannerAgent.generate(prompt, { structuredOutput: { schema: routingSchema } });
  return result.object.specialists;
}
```

The specialists are three more agents with narrow instructions and the same output schema (a summary plus findings tagged info, warning or blocker). The pipeline runs whichever ones the planner picked with `Promise.all`, then stitches their sections into a single comment, with a line at the bottom listing who was skipped and why.

That's most of it. The merge step is a string join, and I think that's the right amount of cleverness for it.

## A real run

To see it work I opened a PR on the sandbox repo that was bad on purpose: a new `src/export.ts` with a hardcoded `sk_live_` token, a file name taken straight from the query string and concatenated into a path, and an `exec("gzip /var/exports/" + fileName)` for good measure.

The webhook arrived at 12:39:35 and the comment landed at 12:39:51, so sixteen seconds end to end. The security reviewer returned five findings, including the hardcoded token, the path traversal, the command injection, and the `==` comparison against the token (not constant-time). The style reviewer found one thing (a `var` used for a constant) and the test-coverage reviewer pointed out that none of it had tests.

I should be honest about what that run proves. The planner routed to all three specialists, which is the correct answer for that diff, but a diff that is wrong on every axis gives the planner nothing to decide. I haven't pushed a docs-only change through it yet, so I can't tell you the routing holds up when it should say no. That's the next thing to try.

## Webhook plumbing

GitHub needs a public HTTPS URL to deliver to, and a laptop doesn't have one, so the demo uses a smee.io channel and a small forwarder. The receiver checks the signature before doing anything else:

```ts
const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
const expectedBuf = Buffer.from(expected);
const actualBuf = Buffer.from(signatureHeader);
if (expectedBuf.length !== actualBuf.length) return false;
return timingSafeEqual(expectedBuf, actualBuf);
```

Even on a throwaway repo, we don't skip this. When I came back to the demo I no longer had the original webhook secret, so I rotated it with `gh api` and wrote the new one straight into `.env`. If you're going to lose a secret, a webhook secret is a good one to lose.

## Pin your versions

The one real surprise was dependencies. A plain `npm install` with caret ranges resolved `@mastra/core@1.67.0` next to `@ai-sdk/anthropic@4.0.58`, and the project stopped typechecking (the two disagreed about the shape of `LanguageModelV4`). Mastra and the AI SDK provider packages aren't semver-safe against each other, so we pinned exact versions to the ones the kampong engine already uses:

```json
"@ai-sdk/openai": "4.0.57",
"@mastra/core": "1.64.0",
"ai": "7.0.91"
```

There's a second gotcha in the same area. OpenRouter only implements the classic Chat Completions API, and the bare `createOpenAI(...)(name)` call defaults to the newer Responses API, so it quietly talks to an endpoint that doesn't exist. You want `.chat(name)`.

## What it says about kampong-agents

kampong v1 is single-agent only, on purpose. This demo shows what the first version of `sub_agents` would have to cover: a way to say who gets routed to (a static list, or decided by a planner as here), a fan-out and fan-in execution shape that the current linear and conditional workflows don't have, and a way to give each sub-agent its own instructions and model without copying the whole spec schema per agent. We also learnt that the exporter should emit exact version pins, since generated projects will hit the same typecheck failure the first time someone runs `npm install`.

Neither of these is hard on its own. The routing question is the one I'd want settled before we write any schema.
