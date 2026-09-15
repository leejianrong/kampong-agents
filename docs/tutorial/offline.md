# Running offline

A good dev loop doesn't depend on the network. Kampong Agents can run an agent with zero network
calls: a local model for the thinking, and recorded fixtures for the tool calls.

## Mock and record tool calls

Real HTTP calls are slow and change their answers. The `--tools` flag on `kampong run` controls
how tool calls are handled:

| Mode             | Behavior                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `live` (default) | Every tool call hits the real network.                                                                                  |
| `record`         | Calls live once and saves the response to a fixture file.                                                               |
| `replay`         | Never touches the network, and reads the saved fixture. A cache miss is an execution failure, never a silent live call. |

Record once:

```sh
kampong run agent.yaml --input "order 1234" --tools record
```

Then replay forever, deterministically and offline:

```sh
kampong run agent.yaml --input "order 1234" --tools replay
```

Fixtures land in `<spec dir>/.kampong/fixtures` by default. Point elsewhere with `--fixtures
<dir>`. Because they're deterministic, they make tool behavior safe to commit and repeat in tests.

!!! note "Secrets never reach a fixture"
    Any resolved BYOK key in play is scrubbed before a fixture is written, so recording a call
    can't leak your key into a file you might commit.

## Use a local model

Pair replay with a local Ollama model and the run needs no network at all. Set the spec's model to
Ollama, with no API key:

```yaml
model:
  provider: ollama
  name: llama3.2
  base_url: http://localhost:11434
```

Start Ollama and pull the model once:

```sh
ollama serve
ollama pull llama3.2
```

## Fully offline, end to end

A local model plus replayed tools gives you a run that touches nothing external:

```sh
kampong run agent.yaml --input "order 1234" --tools replay
```

You can verify the claim. Cut your network (airplane mode, or a firewall rule) and run it again.
It completes with the same output.

!!! warning "No silent fallback, ever"
    If Ollama isn't running, the run fails with a clear error. It will not quietly call a paid
    cloud API instead. If a `replay` fixture is missing, that's an execution failure, and it will
    not quietly make a live call. Offline means offline, and a broken assumption is surfaced, not
    hidden.

## No telemetry

Nothing about a local run phones home. There's no telemetry by default, and the tool doesn't
report your usage anywhere unless you explicitly opt in.

Next: take the finished agent out of the tool entirely, with
[Ejecting to TypeScript](exporting.md).
