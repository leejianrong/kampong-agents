# UX audits: how to run one, and the log

A UX audit is two agents using the real app in a browser, as a first-time person would, and filing what is hard,
unclear or broken as cards. The product is aimed at someone who can prompt an LLM but does not read traces for a
living (ADR-0053, ADR-0063), so what they see is the product. This file is the process and the running log, so any
agent can tell **when the next audit is due**.

## When one is due

Run an audit when **any** of these is true. Look at the newest row of the log below.

- The last round is **7 days old or more**.
- **Five or more UI slices** have merged since the last round (count merged PRs that touch `apps/canvas/`).
- A release or a demo is coming.
- A person asks for one.

If you start a feature slice and the last round is overdue, run the audit first or say why it waits.

## How to run one

1. Read the log below, so you do not re-report what is known, and `pandan list --board 26` for open cards.
2. Create an epic for the round (`pandan epic create "UX audit findings, round N"`), or reuse the open audit epic
   if it still has open cards.
3. Start **two** auditors, no more (the global limit is two subagents at once), each told to:
   - drive the running app **through the browser only** (Playwright with Chromium: clicks, typing, keyboard), take
     screenshots at each step and base every finding on them; reading code is only for suggesting a fix;
   - run the app with `make try-demo` (Replay, no keys) and `make try` (blank), on a free port, stop it when done,
     and not delete a `.try/` folder something else is using;
   - check the board first and **comment on an existing card instead of filing a duplicate**;
   - file **one card per finding**, 1-5 points, a specific outcome as the title, a description of
     Why / Do / Done when / Not in scope, with a severity (high, med, low), at most 12 cards each, no assignee,
     no cycle; change **no code**.
4. The two auditors split the ground so they do not overlap:
   - **Visual and information design**: the run log and Timeline, the canvas, density, wording, empty and error
     states, contrast, keyboard use, light and dark, a desktop and a phone width.
   - **Journeys and workflows**: start from a template, build and edit (by hand and with the assistant), test with
     Replay and Live, read failures, approvals, triggers and deploy as far as they show locally, error messages,
     the CLI help and the docs.
5. Add a row to the log below **in the same PR as the first fix, or on its own if there is none**, with the date,
   what was covered, the cards and an overall verdict. Update the status column as cards ship.
6. Report to the owner: the cards by severity, what is good, what needs a decision.

## What the auditors have found to be true so far

Things worth checking again, because they regress easily:

- The answer to "what happened?" must be the first thing seen after a run, in words, not a list of steps.
- A failure says what went wrong and what to do; the raw message is one click down.
- Anything that needs a key, a server or a model says so **before** the person tries it, and offers the fix.
- Layout at a phone width and on a short window (700px tall) breaks first.
- Wording leaks developer detail: environment variable names, CLI flags, file paths, internal document names.

## The log

Newest first. **Next audit due: 2026-11-28**, or sooner under the rules above.

### Round 1: 2026-11-20

- **Auditors:** two, both driving Chromium through the UI (visual and information design; journeys and workflows).
  Light and dark, 1440x900 and 390x844. Epic KAM-E43.
- **Verdict (visual):** the bottom run panel opened on 21 flat rows with the plain-words summary hidden behind a tab,
  showed raw HTTP text and JSON, mislabelled a partly failed run as informational (blue), and was unusable at 390px.
  M3 tokens, contrast and empty or loading states were otherwise fine.
- **Verdict (workflow):** run safety is good (Live asks first, failures link to the fix, delete explains itself).
  The trust feature is hard to find (the demo never reaches an approval and an approval did not survive a reload),
  the assistant was inconsistently gated, wording leaked developer detail, and install and deploy were developer-only.
- **Fixed in:** PRs #294 to #297 (visual) and #298 to #305 (workflow), 2026-11-20 to 2026-11-21.

| Card | Finding | Sev | Status |
| --- | --- | --- | --- |
| KAM-269 | Lead the run log with a plain-words outcome | high | Done, #295 |
| KAM-270 | Plain reason and next step for a failed step | high | Done, #296 |
| KAM-271 | Readable fields instead of raw JSON | high | Done, #296 |
| KAM-272 | Run result chip says success, warning or failure | high | Done, #295 |
| KAM-273 | Run log usable on a narrow screen, resizable | high | Done, #297 |
| KAM-274 | Timeline rows in business words | med | Done, #295 |
| KAM-275 | Run log header cut to what a person acts on | med | Done, #295 |
| KAM-276 | Runs badge, collapse button, spacing | low | Done, #294 |
| KAM-277 | Run log keyboard operable | med | Done, #296 |
| KAM-278 | Secrets not red in Replay | med | Done, #294 |
| KAM-279 | Canvas fits the workflow on load and after a run | med | Done, #294 |
| KAM-280 | Pending approval survives a reload | high | Done, #298 |
| KAM-281 | Replay with no recording says what to do | high | Done, #299 |
| KAM-282 | One assistant status, plain failure | high | Done, #300 |
| KAM-283 | The demo never shows an approval | med | Done, #308 (demo re-recorded as an unsure ticket) |
| KAM-284 | Approval dialog says what each button does | med | Done, #301 |
| KAM-285 | Templates before the assistant box | med | Done, #302 |
| KAM-286 | Explain Vars, Checks and Test Run | med | Done, #303 |
| KAM-287 | Name the reason on the Could not start chip | med | Done, #303 |
| KAM-288 | Install without cloning the repo; help text | med | Partly done: help text #305; installs from tarballs (#310); the registry one-liner awaits the owner |
| KAM-289 | Say a trigger is not running locally | med | Done, #304 |
| KAM-290 | Plain titles on cards | low | Open |
| KAM-291 | Saved only after a file exists | low | Done, #302 |

Not covered in round 1, so cover it in round 2: the hosted flow (sign in, workspace, BYOK key, deploy), the
Test Run panel with a long or failing loop, and the webhook and poll triggers end to end.
