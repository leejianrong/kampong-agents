# Getting started

This page takes you from a clean checkout to a running agent. It should take a couple of
minutes.

## Prerequisites

- **Node.js 22 or newer.** Check with `node -v`. The repo pins a version in `.nvmrc`, so
  `nvm use` picks it up if you use nvm.
- **An API key for a model**, or a local Ollama install. The starter agent uses
  [OpenRouter](https://openrouter.ai), which has a free tier and needs only a key, no local
  setup. If you'd rather run fully offline, see [Running offline](tutorial/offline.md).

## Install and build

From the repo root:

```sh
npm install
npm run build
```

`npm install` sets up every workspace. `npm run build` compiles the packages and builds the
canvas UI. You need the build step before `kampong dev` can serve the canvas, because it serves
the compiled assets rather than a live dev server.

!!! tip "Working on the tool itself?"
    `npm test` runs the fast unit and integration layers. See
    [`AGENTS.md`](https://github.com/leejianrong/kampong-agents/blob/main/AGENTS.md) in the repo
    for the full command list and contributor conventions.

## Set your API key

Secrets never live in a spec file. A spec only ever references an environment variable, like
`${OPENROUTER_API_KEY}`. The real value lives in your environment or a `.env` file.

```sh
cp .env.example .env
```

Open `.env` and set your key:

```sh
OPENROUTER_API_KEY=sk-or-...
```

Get a free key at [openrouter.ai/keys](https://openrouter.ai/keys).

## Run the starter agent

The repo ships a starter spec at `examples/agent.yaml`. Point a headless run at it:

```sh
kampong run examples/agent.yaml --input "Hi, what can you do?"
```

You'll see the run's steps stream by, then the final output. That's a complete agent executing
against a real model call.

## Open the canvas

To see and edit the same agent visually:

```sh
kampong dev examples
```

`kampong dev` starts a local server and prints a URL, by default
[http://localhost:4310](http://localhost:4310). Open it. You'll see the agent laid out as
blocks, the trigger and the workflow step, with a live YAML panel beside them. Edit either side
and the other updates. Press **Run**, type an input, and watch the trace fill in step by step.

!!! note "Running the app in Docker"
    If you juggle several projects and ports collide, `make up` runs the canvas in a container
    on one configurable port (`HOST_PORT` in `.env`, default 4310). `make up` seeds
    `workspace/agent.yaml` from the starter spec on first run, `make logs` follows the logs, and
    `make down` stops it.

!!! note "Running it as a shared, signed-in service"
    `kampong dev` is single-user and edits one file. There is also a
    [hosted app](hosted-app.md) — the same canvas with sign-in, per-workspace specs, and
    server-side provider keys — for running Kampong Agents as a multi-tenant service. The
    agent-building steps in this tutorial are identical in both.

## What just happened

You ran one `AgentSpec` file two ways, headless and on the canvas, with no import or conversion
between them. That file is the unit you'll build up from here.

Next: **[Your first agent](tutorial/first-agent.md)**, which pulls the starter spec apart field
by field and starts extending it.
