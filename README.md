# Kampong Agents

A dev-first agent-workflow builder where the visual canvas and the underlying YAML spec are
the same thing, not two things kept in sync by convention. Design an agent on the canvas, or
hand-write the YAML in Cursor or Claude Code: either way you get one file, always safe to
commit, diff, and review. When you're ready, eject to a standalone TypeScript project with
zero further dependency on this tool.

## Status

Early. V1-V4 (canvas/YAML duality, local execution engine with guardrails/HITL, the local-first
CLI with mock/record tools and an Ollama adapter, and TypeScript export) are built and merged —
see [`SLICES.md`](./SLICES.md) for what's shipped versus roadmap.

```mermaid
flowchart LR
  canvas["Visual canvas"]
  spec["AgentSpec YAML\n(single source of truth)"]
  external["Cursor / Claude Code / Codex\n(hand-edit directly)"]
  export["Eject: standalone\nTypeScript project"]

  canvas <--> spec
  external <--> spec
  spec --> export
```

## Design docs

- [`PLAN.md`](./PLAN.md): the problem, the scope, the requirements, the shape of the system.
- [`SLICES.md`](./SLICES.md): the build sequence, one demoable slice at a time.
- [`docs/adr/`](./docs/adr/): the architecture decisions and why each one was made.
- [`ideation.md`](./ideation.md): the original research this project grew out of.

## Working on this repo

```sh
npm install
npm run build
npm test
```

That installs every workspace, builds every package, and runs the fast (unit + integration)
test layers. See [`AGENTS.md`](./AGENTS.md) for the full command reference, repo layout, and
the conventions any change here should follow.

## Run with Docker

If you're running several full-stack projects on the same laptop and ports keep colliding,
`make up` runs the app in Docker on one configurable port, so a collision only ever costs
you one line in `.env`:

```sh
make up      # builds the image, seeds workspace/agent.yaml from examples/agent.yaml, starts
             # the container -- prints the canvas URL (http://localhost:4310 by default)
make logs    # follow the container's logs
make down    # stop the stack
```

If `4310` is taken by another project, copy `.env.example` to `.env` (`make up` does this for
you automatically) and change `HOST_PORT` there. Your spec lives in `./workspace/agent.yaml`
(gitignored, bind-mounted into the container) — edit it by hand or through the canvas at the
printed URL; either way it persists across `make down`/`make up`. To run the example spec's
Ollama model, point Ollama at your laptop first (`ollama serve`, `ollama pull llama3.2`) — a
spec's `model.base_url` needs `http://host.docker.internal:11434` to reach your host's Ollama
from inside the container, not `localhost` (which means the container itself). For BYOK cloud
providers, set `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in `.env`.

`make help` lists every target, including the non-Docker local gate (`make check`, `make test`,
`make lint`, ...) as a thin wrapper over the npm scripts in [`AGENTS.md`](./AGENTS.md).

Issues and PRs are welcome. Read `AGENTS.md` first, since several of the design decisions
there (YAML as source of truth, TypeScript/Mastra only, no telemetry by default) are
intentional and load-bearing, not oversights.

## License

Apache 2.0. See [`LICENSE`](./LICENSE).
