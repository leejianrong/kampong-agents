# support-triage

A support-inbox assistant written as a spec only: no code, no custom components. Every few minutes it reads
**one** unread email from a Gmail inbox, has a model classify it and draft a reply from a short FAQ, and leaves
the reply as a **draft** in Gmail. When the model is confident the draft is saved straight away; when it is not,
a person approves it in Slack first. Nothing is ever sent: the result is a draft you open and send yourself. It
mirrors `mastra-projects/support-triage`.

```
schedule (every 5m)
  inbox        kampong/gmail-imap list_unseen (limit 1)
  nothing_new  branch   no unread mail -> stop quietly until the next tick
  message      kampong/gmail-imap get_message          (does not mark it read)
  triage       model call, FAQ injected, output_schema { category, confidence, reply }
  claim        kampong/gmail-imap mark_seen
  decide       branch   confidence >= vars.threshold (default 0.8)
    then:        draft_confident  create_draft, threaded under the email
    else:        review           approval, posted to Slack with Approve / Reject
                 draft_approved   create_draft
```

Why one email per run: an approval pauses a run, and a run that waits on a person should not hold up the rest of
the inbox. The next tick takes the next email. (A `poll` trigger that starts one run per unread email is planned,
KAM-117; this is the same shape built on `schedule`.)

Why the email is marked read before the approval: so a **rejection** does not bring the same email back on the
next tick. The pending approval is stored on disk and survives a restart, so nothing is lost while it waits. A
failure before that point (the model call, say) leaves the email unread and it is tried again. A failure while
saving the draft after you approve is reported as a failed run and the email stays read, so look at failed runs.

## Try it offline

Recorded fixtures for the Gmail operations are in `fixtures/`. Nothing below needs a mailbox, a credential or the
network, except the model:

```
kampong templates                                   # lists this template and where it lives
kampong doctor agent.yaml --tools replay --fixtures fixtures
kampong run agent.yaml --input "" --tools replay --fixtures fixtures --json
```

The recording is one scenario: a confident email about a password reset, so the draft is saved without an
approval. (A fixture is keyed by the operation and its input, so a second mailbox would answer the same
`list_unseen` differently; the tests cover the unsure, rejected and empty-inbox cases against a scripted
mailbox instead.) The fixtures come from a scripted mailbox, not a capture of a real account. To record your own,
run live once with `--tools record` and your credentials.

One limit of the offline run today: **model calls are not recorded** (KAM-156), so the `triage` step calls the
spec's `agent.model`, which is a local Ollama by default. With no Ollama running that step fails visibly (it
never falls back to a paid API). Run `ollama serve` and `ollama pull llama3.1`, or point `agent.model` at
OpenRouter or another provider.

## Run it live

| Variable               | What it is                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `GMAIL_ADDRESS`        | The Gmail address to read and draft in                                                          |
| `GMAIL_APP_PASSWORD`   | A Google **app password** (needs 2-Step Verification), not the account password; IMAP turned on |
| `SLACK_BOT_TOKEN`      | A bot token with `chat:write`, invited to the approvals channel                                 |
| `SLACK_SIGNING_SECRET` | The Slack app's signing secret, so the Approve / Reject buttons can be checked                  |
| the model's own key    | Only if you change `agent.model` from the local Ollama default                                  |

Check the setup first. `--probe` signs in to Gmail (and nothing else) to confirm the app password is accepted:

```
kampong doctor agent.yaml --online --probe
```

Then run it as a service:

```
kampong serve agent.yaml --port 8080
curl -X POST localhost:8080/schedule/run-now      # start a run now instead of waiting for the tick
```

### Approvals

When the model is unsure the run pauses and the approval goes to the `#support-approvals` channel (edit
`approval_notifier.channel`). Slack's buttons need a public HTTPS URL, which a laptop does not have: see
[Slack approvals on your own machine](../../../../docs/tutorial/slack-approvals.md) for the four things that go
wrong and how to set it up. Without it you can still approve from the command line, and the run waits across a
restart either way:

```
curl localhost:8080/approvals                                                    # what is waiting
curl -X POST localhost:8080/approvals/<key>/approve -H 'content-type: application/json' -d '{"approved": true}'
```

## Make it yours

- **The FAQ** is the `knowledge_base` text. The model is told to answer only from it and the email, and to give a
  low confidence for anything it does not cover or that involves identity, account changes, refunds, legal or
  security topics. Rewrite both the FAQ and those rules for your product.
- **The threshold** is `vars.threshold` (`--var threshold=0.9` to ask a person more often). A model's confidence
  is its own estimate, not a measurement, so start high and lower it only as you see how it behaves.
- **The email is untrusted.** It goes into the prompt as data and the instructions say to ignore anything in it
  that tries to change the rules. The only thing a confident reply can do is become a draft you read, which is
  why this template saves drafts and does not send.
