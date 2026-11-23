# Run a workflow on a webhook

A webhook trigger lets another system start your workflow: an alerting tool, GitHub, a form. This page takes the
`webhook-triage` template from "it runs when I press Run" to "it accepted a real request", on your own machine.
It needs no hosting and no tunnel. Reaching it from the internet is a separate step (see the end).

## 1. Look at the trigger

Open `webhook-triage` in the canvas and select the trigger. With `kampong dev` the panel reads:

> Webhook: alertmanager preset, async response

and has a **Go live** block with the same steps as below. In the spec the trigger is:

```yaml
trigger:
  type: webhook
  preset: alertmanager
  auth:
    secret_env: ALERT_WEBHOOK_TOKEN
  when: 'trigger.status = "firing"'
```

`preset: alertmanager` means the sender proves who it is with a bearer token. `secret_env` is the _name_ of the
environment variable that holds that token; the token itself never goes in the file.

## 2. Start the service with a token

Make a long random token and start `kampong serve` with it set:

```sh
export ALERT_WEBHOOK_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
kampong serve agent.yaml
```

`serve` prints the address it listens on (`http://localhost:8080/webhook`) and, before any request, lists what
would stop the first run: here `SLACK_BOT_TOKEN` and the local model (Ollama), which the template uses by default.
The service still starts. `kampong serve` always runs for real; it has no replay mode (use `kampong run` with
`--tools replay` for that). Run `kampong doctor agent.yaml` for the same list on its own.

## 3. Send the first request

In a second terminal, in the same shell so the variable is set:

```sh
curl -X POST http://localhost:8080/webhook \
  -H "authorization: Bearer $ALERT_WEBHOOK_TOKEN" \
  -H "content-type: application/json" \
  -d '{"status":"firing","groupLabels":{"alertname":"CheckoutErrorRate"},"alerts":[]}'
```

The answer is `201` and the run's id and URL:

```json
{ "success": true, "id": "…", "url": "http://localhost:8080/runs/…" }
```

`GET` that URL for the run's state. The `serve` terminal logs one line when the run starts and one when it ends.
A `201` means the request was accepted, not that the run worked: with Ollama not running, the run fails a moment
later and the log says why (`failed: Could not reach the local Ollama server…`). `GET /runs` lists recent runs
with their outcomes.

## 4. Check it: what each answer means

| You see                        | It means                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `201` with an `id`             | Accepted. A run started.                                                                           |
| `200` with `"ignored": true`   | Accepted but no run: the `when` rule was false (here, a `resolved` alert). The reason is in the body. |
| `401`                          | The token is missing or wrong, or `ALERT_WEBHOOK_TOKEN` is not set where `serve` runs. It never says which. |
| `400`                          | The body says it is JSON and is not.                                                               |

`GET /triggers/ignored` lists the requests the rule ignored. A run that pauses for approval waits at
`POST /runs/<id>/approve` ([Slack approvals locally](slack-approvals.md)).

## A signed sender (GitHub, Slack)

`preset: github` and `preset: slack` check a signature, not a bearer token: the sender signs each body with the
secret and sends the signature in `X-Hub-Signature-256` (GitHub) or `X-Slack-Signature` (Slack). You paste the
same secret into the sender's settings, so there is no curl to type by hand; the **Go live** block names the
header instead.

## Reaching it from outside

`localhost` is only your machine. To let a service on the internet call it, run `kampong serve` somewhere it can
be reached (a server, or the hosted deployment, where a deployed spec gets its own `/hooks/w/<workspace>/<deployment>`
address and a generated secret) or put a tunnel you trust in front of it. kampong does not start a tunnel for you.

The full list of endpoints is in the [CLI reference](../reference/cli.md#kampong-serve) and the trigger's fields
are in the [AgentSpec reference](../reference/agentspec.md).
