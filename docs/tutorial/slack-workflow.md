# Build your first workflow: draft, approve, post to Slack

This page builds a small workflow on the canvas, using only the forms. The agent drafts a
message, waits for you to approve it, then posts it to a Slack channel. It takes about ten
minutes, most of which is the one-time Slack setup.

By the end you will have used the three things you need for most workflows: an action step (the
model writes something), an approval step (a human decides), and a tool step (something happens
in the real world).

## Before you start

You need the canvas running and a model key. If you started the Docker stack with `make up`, the
canvas is at <http://localhost:4310> and it opened the starter agent from
`workspace/agent.yaml`. If you use `kampong dev`, see [Getting started](../getting-started.md).

You also need a Slack bot token and a channel. The setup is in
[Demo: support triage](../demo.md#1-set-up-slack): create an app, add the `chat:write` scope,
install it, invite the bot to a channel, and note the channel ID.

Put the values in `.env`:

```sh
OPENROUTER_API_KEY=...
SLACK_BOT_TOKEN=xoxb-...
```

A spec never contains a secret, only the name of the variable. The canvas won't ask you for the
token and never shows it.

!!! note "After editing `.env`, recreate the container"
    The Docker stack reads `.env` when the container starts. Run `make restart` after you change
    it, or the app keeps the old values.

## The starting point

The starter agent has one step, `greet`, that asks the model to answer the input. On the canvas
you see a trigger, the agent, and one workflow step, with the YAML next to them. Everything you do
below changes that YAML, and you can read it at any point.

## 1. Add the Slack tool

A tool describes something the agent can do. It does nothing until a workflow step uses it.

1. Click **Add Tool**.
2. Set **Tool kind** to **Slack**.
3. **Name**: `post_to_slack`.
4. **Token (env reference)**: `${SLACK_BOT_TOKEN}`. This is the variable name, not the token.
5. **Channel**: the channel ID, for example `C0123456789`, or a name like `#support-triage` for
   a public channel. A private channel needs the ID.
6. **Text**: `{{ greet.text }}`. This inserts the output of the `greet` step.
7. Save.

A tool node appears on the canvas and a `tools:` entry appears in the YAML.

## 2. Add an approval step

1. Click **Add Workflow Step**.
2. Set **Step kind** to **Approval**.
3. **Step ID**: `review`.
4. **Message**: `Post this to Slack? {{ greet.text }}`.
5. Save.

The run will stop at this step and show the message to whoever is running it. If they reject, the
run ends and nothing is posted.

## 3. Add the tool step

1. Click **Add Workflow Step**.
2. Set **Step kind** to **Tool**.
3. **Step ID**: `send`.
4. **Tool name**: `post_to_slack`.
5. Save.

Steps run in the order they appear, so the workflow is now `greet`, then `review`, then `send`.

## 4. Check your setup

Click **Checks**, turn on **Also check credentials**, and run the checks. The panel lists each
variable the spec needs by name, and it asks Slack whether the token is accepted. It never
displays a value. Fix anything marked as failing before you run.

## 5. Run it

1. Click **Test Run**.
2. In **Input**, type something for the model to answer, for example
   `Write a two-line welcome for new support customers.`
3. Click **Run**.

The trace shows each step as it finishes. At `review` an **Approval required** dialog shows the
drafted text. Click **Approve** and the `send` step posts it. Open the channel in Slack to see
the message.

## What you built

This is the whole workflow in YAML. You can edit it in the YAML panel, or in any editor, and the
canvas updates.

```yaml
version: "1.0"
agent:
  id: hello_agent
  name: "Hello Agent"
  role: "Friendly assistant"
  goal: "Greet the user warmly and answer one question in a concise, helpful tone."
  model:
    provider: openrouter
    name: liquid/lfm-2.5-2.6b:free
    api_key: ${OPENROUTER_API_KEY}
  tools:
    - name: post_to_slack
      action: slack_post_message
      token: ${SLACK_BOT_TOKEN}
      channel: "#support-triage"
      text: "{{ greet.text }}"
  workflow:
    - step: greet
      action: generate_text
      inputs: [input]
    - step: review
      type: approval
      message: "Post this to Slack? {{ greet.text }}"
    - step: send
      type: tool
      tool: post_to_slack
```

## Going further

- **Give a step its own prompt.** On an action step, the optional **Instructions**, **Model** and
  **Temperature** fields override the agent's role and goal, model and sampling temperature for
  that step only. They need `version: "1.1"` at the top of the spec.
- **Branch on the result.** Add a **Condition** step to take a different path, for example to
  escalate instead of sending. See [Workflows and conditions](workflows.md).
- **Run it from the terminal or as a webhook service.** See [Demo: support triage](../demo.md),
  which does this with a fuller spec.

## If something goes wrong

| What you see                                   | Likely cause                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Checks says a variable is not set              | The variable is missing from `.env`, or you did not run `make restart` after adding it.               |
| The run fails with `not_in_channel`            | The bot is not in the channel. Type `/invite @your-bot` in it.                                        |
| The run fails with `channel_not_found`         | Wrong channel. A private channel needs its ID, not its name.                                          |
| The run fails with `invalid_auth`              | The token is wrong or was revoked. Reinstall the app and copy the new token.                          |
| The model step fails                           | The OpenRouter key is missing or out of credit. Checks shows whether the key is set.                  |
| The run stops at approval and nothing happens  | That is the approval step waiting. Use the dialog in the run panel.                                   |
