# webhook-triage

The lead human-in-the-loop job, written as a spec only: no code, no custom components. A monitoring alert
arrives by webhook, a model decides whether it is worth interrupting people for and drafts the Slack message,
and **a person approves the post** before anything reaches the channel. Noise ends the run quietly.

```
webhook (alertmanager preset, bearer token from ALERT_WEBHOOK_TOKEN)
          when: trigger.status = "firing"      a "resolved" notice is accepted but starts no run
  has_alerts  branch   no alerts in the body -> stop, without asking the model
  triage    model call, output_schema { decision: post|skip, severity, reason, message }
  decide    branch   triage.decision = "post"
    then:     review   approval, posted to Slack with Approve / Reject buttons
              post     kampong/slack post_message to vars.slack_channel (default #oncall)
    else:     quiet    stop, reason = the model's reason
```

Nothing is posted until someone approves, and a rejection ends the run with no post. The alert is passed to the
model as data, with a rule to ignore instructions inside it.

## Try it offline

Recorded fixtures are in `fixtures/`: two model answers and one Slack call. Nothing below needs Slack, a
credential, a model or the network.

```
kampong templates                                   # lists this template and where it lives
kampong doctor agent.yaml --tools replay --fixtures fixtures
kampong run agent.yaml --tools replay --fixtures fixtures --approve-all --json --input '{"status":"firing","groupLabels":{"alertname":"CheckoutErrorRate"},"alerts":[{"status":"firing","labels":{"alertname":"CheckoutErrorRate","severity":"critical","service":"checkout"},"annotations":{"summary":"Checkout is failing 38% of payments since 09:14 UTC."}}]}'
```

That is the recorded critical alert: the model decides to post, the approval is auto-approved by
`--approve-all`, and the Slack post replays. Leave `--approve-all` off to be asked on the terminal (`y`, or
`n:<reason>` to reject). The second recorded alert, `DiskUsageHigh` (a flapping warning), is judged noise and
the run stops at `quiet` without asking anyone or posting.

A model fixture is keyed on the whole prompt, so an alert with different text has no recorded answer: the run
fails at `triage` with a "No recorded model fixture" message (a visible failure, never a call to a live model).
Record more with `--tools record`, or use `--model live` to send the call to the spec's `agent.model`.

The fixtures were produced by `e2e/fixtures/record-webhook-triage-fixtures.mjs` with a scripted stand-in model
and a fake Slack, not captured from a live workspace or model. To record your own, run once live with
`--tools record` and your keys.

## Run it live

| Variable              | What it is                                                                         |
| --------------------- | ---------------------------------------------------------------------------------- |
| `ALERT_WEBHOOK_TOKEN` | The bearer token the sender must present. Anything long and random.                |
| `SLACK_BOT_TOKEN`     | A bot token with `chat:write`, invited to the alert channel and approvals channel. |
| the model's own key   | Only if you change `agent.model` from the local Ollama default.                    |

`kampong serve agent.yaml` listens for `POST /webhook`. Point Alertmanager's `webhook_configs` at it with an
`http_config.authorization` bearer credential, or test with curl:

```
curl -X POST http://127.0.0.1:8080/webhook \
  -H "authorization: Bearer $ALERT_WEBHOOK_TOKEN" -H "content-type: application/json" \
  -d '{"status":"firing","groupLabels":{"alertname":"CheckoutErrorRate"},"alerts":[...]}'
```

The POST answers `201` at once with a run id. The run then pauses at `review` and Slack's `#oncall-approvals`
gets Approve and Reject buttons (change the channel in `approval_notifier`); the approval is stored on disk and
survives a restart. Slack buttons need the app's interactivity URL and `SLACK_SIGNING_SECRET`; see
[ADR-0049](../../../../docs/adr/0049-slack-approval-local-story.md). Without them, resolve it with
`POST /runs/<id>/approve` and `{"approved": true}`.

## Notes

- `kampong run` takes the alert as `--input` and does not apply the trigger's authentication or `when`; those
  apply to `kampong serve` and an exported project's server.
- Version 1.1 spec: the hosted server does not run 1.1 specs yet (KAM-203), so this runs locally or self-hosted
  for now.
- Only environment variable names appear in the spec (`secret_env`, `${SLACK_BOT_TOKEN}`), never values.
