# Demo: support triage with a real Slack post

This walkthrough runs `examples/support-triage-demo.yaml`. A support message arrives on a
webhook. The agent classifies it into a typed object, looks the customer up over HTTP, drafts a
reply, waits for you to approve it, and posts the reply to a Slack channel.

It shows the version 1.1 features: `vars`, `trigger.*`, expressions in `{{ }}`, a validated
`output_schema`, and per-step `instructions` and `temperature`. The model is a cheap DeepSeek
model on OpenRouter.

## What you need

- Node.js 22 or newer, and the repo built (`npm install && npm run build`).
- An [OpenRouter](https://openrouter.ai/keys) API key.
- A Slack workspace where you can install an app (steps below).

## 1. Set up Slack

You need a bot token and a channel. It takes about five minutes.

1. Go to <https://api.slack.com/apps>, choose **Create New App**, then **From scratch**. Name it
   (for example `kampong-demo`) and pick a workspace. A personal test workspace avoids needing
   admin approval.
2. Open **OAuth & Permissions**. Under **Bot Token Scopes**, add `chat:write`. Add
   `chat:write.public` too if you want it to post in public channels without being invited.
3. Click **Install to Workspace** at the top of that page, then **Allow**.
4. Copy the **Bot User OAuth Token** (it starts with `xoxb-`). This is `SLACK_BOT_TOKEN`.
   If you change scopes later, click **Reinstall to Workspace**. The token stays the same.
5. Create a channel such as `#support-triage`, then type `/invite @kampong-demo` in it. Without
   the invite, Slack answers `not_in_channel` (unless the channel is public and you added
   `chat:write.public`).
6. Set `SLACK_CHANNEL`. The channel ID is the most reliable value: right-click the channel,
   choose **View channel details**, and copy the ID at the bottom (it looks like `C0123456789`).
   A name like `#support-triage` works for a public channel. A private channel needs the ID.
7. Optional, only for Approve and Reject buttons on a headless `kampong serve` run: copy the
   **Signing Secret** from **Basic Information** into `SLACK_SIGNING_SECRET`, turn on
   **Interactivity & Shortcuts**, and set its Request URL to
   `https://<your-public-host>/slack/interactions`. Slack cannot reach `localhost`, so this needs
   a tunnel such as ngrok or Cloudflare. In the canvas, approval is the in-app dialog and none of
   this is needed.

## 2. Put the secrets in `.env`

```sh
cp .env.example .env
```

Fill in `OPENROUTER_API_KEY`, `SLACK_BOT_TOKEN` and `SLACK_CHANNEL`. `.env` is gitignored, and a
spec never holds a value, only the `${ENV_VAR}` name. Don't paste these into chat, issues or
commits.

You can also set them from the canvas: **Variables** lists every name the spec needs (including the
Slack token, which the Slack component reads on its own), and lets you set or replace a value. Values
are saved to `.kampong/secrets.env` on this machine and are never shown again. This applies to the canvas
(`kampong dev`, `make up`); `kampong run` and `kampong serve` still read the process environment.

The CLI reads its process environment and does not load `.env` itself, so load it into your shell
first:

```sh
set -a; . ./.env; set +a
```

This runs `.env` as shell code, so a value with an unquoted space breaks it. Quote such a value
(`NAME="two words"`). The Docker stack (`make up`) reads the same file without this step.

## 3. Check the setup

```sh
node packages/cli/dist/cli.js doctor examples/support-triage-demo.yaml --probe --online
```

`doctor` lists each variable by name only (never a value), and `--probe` asks Slack whether the
token is accepted. You want `Nothing would stop a run.`

## 4. Run it in the canvas

```sh
cp examples/support-triage-demo.yaml workspace/agent.yaml
node packages/cli/dist/cli.js dev workspace
```

Open <http://localhost:4310>. You see the trigger, the two tools and the five workflow steps
(`classify`, `lookup`, `draft`, `review`, `send`). The YAML panel on the right is the same file.

Click **Test Run** and paste:

```json
{"customer_id":3,"subject":"Charged twice this month","body":"Hi, I was charged twice for my subscription on the 3rd. Can you refund the duplicate? Thanks, Clementine"}
```

The run pauses at `review` with the drafted reply. Approve it and the message appears in your
Slack channel. Try a second message about an outage to see `urgency: high` add the siren emoji in
the Slack text.

## 5. Run it from the terminal

```sh
node packages/cli/dist/cli.js run examples/support-triage-demo.yaml \
  --input '{"customer_id":3,"subject":"Charged twice","body":"I was charged twice on the 3rd."}'
```

It asks for approval on stdin. `--approve-all` approves without asking, and `--var channel=C0123456789`
overrides a var.

To run without touching the network again, record once and replay:

```sh
... run <spec> --tools record --fixtures examples/fixtures/support-triage-demo --input '...' --approve-all
... run <spec> --tools replay --fixtures examples/fixtures/support-triage-demo --input '...' --approve-all
```

Recording makes live calls, including the Slack post. Replay needs no network and no credentials
for tools. The model call is still live.

## 6. Run it as a webhook service

```sh
node packages/cli/dist/cli.js serve examples/support-triage-demo.yaml --port 8080
```

```sh
curl -s -X POST localhost:8080/webhook -H 'content-type: application/json' \
  -d '{"customer_id":3,"subject":"Charged twice","body":"I was charged twice on the 3rd."}'
# { "success": true, "id": "<run id>", "state": ... }

curl -s localhost:8080/runs/<run id>                     # state; paused at "review"
curl -s -X POST localhost:8080/runs/<run id>/approve \
  -H 'content-type: application/json' -d '{"approved":true}'
```

With `SLACK_SIGNING_SECRET` and a public Request URL (step 1.7) the pause also posts an Approve or
Reject prompt to Slack.

## Known limits

- **Export is not available for this spec yet.** `kampong export` refuses version 1.1 specs until
  the exporter passes the webhook payload and vars to the evaluator (KAN-1851).
- **The canvas shows and runs 1.1 specs but has no forms for the new fields yet.** Edit `vars`,
  expressions and `output_schema` in the YAML panel for now (KAN-1850).
- The customer lookup uses the public `jsonplaceholder.typicode.com` API (users 1 to 10), so use a
  `customer_id` in that range. Point `vars.api` at your own service with `--var api=...`.
