# Kampong Agents

https://github.com/user-attachments/assets/319eee49-3011-483b-8494-850d78a9a550

Design an agent workflow on a visual canvas, or hand-write it in Cursor or Claude Code. Either way
you get one YAML file that is always safe to commit, diff and review. Run it locally against any
model (including offline Ollama), put it on a schedule or a webhook, and when you're done, eject it
to a standalone TypeScript project with no dependency on this tool.

```mermaid
flowchart LR
  canvas["Visual canvas"]
  spec["AgentSpec YAML\n(file locally, internal when hosted)"]
  external["Cursor / Claude Code / Codex\n(hand-edit directly)"]
  run["kampong run / serve\n(local engine)"]
  export["Eject: standalone\nTypeScript project"]

  canvas <--> spec
  external <--> spec
  spec --> run
  spec --> export
```

## What you can build

- **Agent workflows** with tools, guardrails and human approval (Slack or terminal). One agent per spec today.
- **Unattended pipelines:** a `schedule`, `poll` or authenticated `webhook` trigger, `foreach` loops that survive
  bad items, `branch`/`stop`, `transform`/`validate`/`dedupe` data steps, structured model output.
- **First-party connectors** for Slack, Gmail, GitHub, Supabase and Alpha Vantage, and a pinned,
  digest-checked component model for your own.
- **Templates to start from:** `market-etl`, a scheduled price pipeline that runs offline on recorded fixtures, and
  `support-triage`, an inbox assistant that drafts replies for a person to send.

## Status

Early, but real. The MVP (canvas/YAML duality, local engine with guardrails and approvals, CLI with
mock/record tools and Ollama, TypeScript export) and the real-world workflow layer (webhooks, connectors,
Slack approvals) are merged. The scheduling, data-step and component work is landing now. A hosted,
multi-tenant server exists but is not deployed yet. Multi-agent orchestration, enterprise governance and
natural-language generation are roadmap. [`SLICES.md`](./SLICES.md) has the per-slice status.

## Quick start

Needs Node 22 or newer.

```sh
npm install
npm run build
npm link -w packages/cli                               # puts `kampong` on your PATH

cp .env.example .env                                   # then set OPENROUTER_API_KEY (free tier works)
kampong run examples/agent.yaml --input "Hi, what can you do?"
kampong dev examples                                   # the canvas, at http://localhost:4310
```

No key? `kampong templates` lists the ready-made specs, and the `market-etl` template runs on recorded
data: see its [`README`](./packages/cli/templates/market-etl/README.md).

## Usage

```sh
kampong dev [dir]                       # canvas (YAML in a "</>" drawer, Alt+Y); edits the file on disk
kampong run agent.yaml --input "..."    # headless run; --tools replay for offline, --approve-all for CI
kampong serve agent.yaml                # webhook, scheduled or polling service (POST /webhook, run-now)
kampong export agent.yaml ./out         # standalone TypeScript project: cd ./out && npm install && npm start
kampong doctor agent.yaml               # preflight: components, credentials, fixtures
```

Edit the YAML in your editor while `kampong dev` is open and the canvas reloads. The full command
reference, the `AgentSpec` schema and a step-by-step tutorial are in [`docs/`](./docs/index.md), a
[Zensical](https://zensical.org) site (`uvx zensical build`, or `uvx zensical serve` to preview).

## Configuration

Secrets never go in a spec, only `${ENV_VAR}` placeholders, with values in `.env` or the environment.
A model is set per spec (`agent.model`): `openrouter`, `openai`, `anthropic` or a local `ollama`. An
unreachable Ollama is a visible error, never a silent fallback to a paid API. Nothing phones home.

## Run with Docker

`make up` builds the image and starts the canvas on `http://localhost:4310`, seeding
`workspace/agent.yaml` from `examples/agent.yaml` (bind-mounted, gitignored, persists across restarts).
If the port is taken, copy `.env.example` to `.env` and change `HOST_PORT`. Set `OPENROUTER_API_KEY` there
to run the example. For offline use, swap the example's model block for the commented Ollama one; inside
the container Ollama is at `http://host.docker.internal:11434`, not `localhost`. `make logs` follows the
logs, `make down` stops it, and `make help` lists the rest.

If you run a machine-wide Traefik proxy, copy `docker-compose.override.yml.example` to
`docker-compose.override.yml` (gitignored) and the stack is also at `http://kampong-agents.localhost/`.

## Contributing

Issues and PRs are welcome. [`AGENTS.md`](./AGENTS.md) is the contributor and agent brief: commands,
repo layout and the conventions that are intentional rather than oversights (the spec as the single truth with YAML as its interchange form,
TypeScript on Mastra only, no telemetry by default). The design lives in [`PLAN.md`](./PLAN.md),
[`SLICES.md`](./SLICES.md) and [`docs/adr/`](./docs/adr/).

## License

Apache 2.0. See [`LICENSE`](./LICENSE).
