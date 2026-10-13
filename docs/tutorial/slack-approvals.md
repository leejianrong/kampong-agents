# Slack approvals on your own machine

A spec can ask a person to approve a step in Slack: set `approval_notifier` and a paused run posts a message
with **Approve** and **Reject** buttons. The buttons work by Slack calling a URL on your server. That is easy on
a hosted service and awkward on a laptop, and the failures are quiet. This page is the four things that go
wrong, and what kampong does about them.

```yaml
agent:
  approval_notifier:
    type: slack
    token: ${SLACK_BOT_TOKEN}
    channel: "#support-approvals"
```

## What kampong does and does not do

kampong **does not start a tunnel**. Slack needs a public HTTPS address and kampong will not open one on your
behalf, because that sends your traffic through a third party you did not choose and `kampong` makes no network
connection you did not ask for ([ADR-0049](../adr/0049-slack-approval-local-story.md)). Instead:

- `kampong serve` prints, once at startup, exactly what Slack needs (below), and warns if
  `SLACK_SIGNING_SECRET` is not set.
- `kampong dev` says the canvas uses its own in-app approval dialog, so nothing needs to be public there, and
  points here for the Slack buttons.
- A paused run never depends on Slack. You can always resolve it with
  `POST /runs/<id>/approve` or `POST /approvals/<key>/approve` (`{"approved": true}`), which is also how you test
  everything except the buttons.

## The four traps

**1. Slack cannot reach `localhost`.** The Interactivity Request URL must be public HTTPS. Run `kampong serve`
and expose its port with a tunnel you already trust (ngrok, cloudflared, a reverse proxy on a server), then set
the Request URL to `https://<your-public-host>/slack/interactions`.

**2. A relay can break the signature, and kampong repairs it.** Slack signs the exact bytes of its
form-encoded request (`payload=<url-encoded JSON>`). Some relays (smee.io is one) parse that body and forward it
as JSON, so the bytes Slack signed are gone and the check can never pass. `kampong serve` and an exported
project rebuild the signed bytes from the JSON (`payload=` plus the RFC 3986 encoding Slack uses, spaces as `+`)
and then verify the signature against them, exactly as before. The check stays fully on: an altered click, or a
forged one, is still refused with `401`. A tunnel that forwards the request untouched (ngrok, cloudflared)
needs none of this.

**3. Socket Mode silently turns the buttons off.** With **Socket Mode** on, Slack delivers clicks over a
websocket and never makes an HTTP request, so nothing arrives, nothing is logged, and the run just waits. In the
Slack app settings, turn Socket Mode **off**.

**4. An app has one Interactivity Request URL.** Pointing a second environment (your laptop, then staging) at
the same Slack app means one of them stops receiving clicks, with no error. Use a separate Slack app per
environment, each with its own bot token and signing secret.

## Setting it up

1. Create the Slack app, add the `chat:write` scope (and `chat:write.public`, or invite the bot to the channel),
   install it, and copy the **Bot User OAuth Token** and the **Signing Secret**.
2. Export both where `kampong serve` runs:

   ```sh
   export SLACK_BOT_TOKEN=xoxb-...
   export SLACK_SIGNING_SECRET=...
   ```

3. Start the service, and expose it:

   ```sh
   kampong serve agent.yaml --port 8080
   ngrok http 8080        # or cloudflared tunnel --url http://localhost:8080
   ```

4. In the Slack app, **Interactivity & Shortcuts**: turn it on, set the Request URL to
   `https://<the-public-host>/slack/interactions`, and confirm **Socket Mode** is off.
5. Trigger a run that reaches the approval. The message appears in the channel; click a button.

If a click does nothing, check in this order: Socket Mode off, the Request URL is the current tunnel address
(a free tunnel changes it on restart), `SLACK_SIGNING_SECRET` is set in the process that is serving, and the
server log for a `401` on `/slack/interactions`.

## A run that waits across a restart

A pending approval is stored in `.kampong/state.db`, so it survives a restart of `kampong serve`: the buttons on
the Slack message, or `POST /approvals/<key>/approve`, still resolve it. Keep `.kampong/` on a volume in a
container.
