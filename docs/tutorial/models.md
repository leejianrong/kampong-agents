# Choosing a model

The `agent.model` block says which model runs your agent and how to reach it. Four providers are
supported today.

```yaml
model:
  provider: openrouter # anthropic | openai | ollama | openrouter
  name: liquid/lfm-2.5-2.6b:free
  api_key: ${OPENROUTER_API_KEY}
```

## Providers

| Provider     | `api_key` | Notes                                                                                                                                             |
| ------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openrouter` | required  | A cloud aggregator. Free-tier models exist, so it's the easiest start. `name` usually carries a vendor prefix, like `anthropic/claude-3.5-haiku`. |
| `anthropic`  | required  | Claude models directly.                                                                                                                           |
| `openai`     | required  | OpenAI models directly.                                                                                                                           |
| `ollama`     | omit it   | A model running locally via [Ollama](https://ollama.com). No key, fully offline.                                                                  |

## Keys are never literals

A spec must never contain a real secret. The `api_key` field only accepts an environment-variable
placeholder in the exact form `${SOME_NAME}`. A literal key fails validation before the agent ever
runs, and that rule is enforced by the schema, not left to convention.

```yaml
api_key: ${OPENROUTER_API_KEY} # ✅ resolved from your environment at run time
api_key: sk-or-abc123 # ❌ rejected: "must reference an environment variable"
```

Set the value in your environment or a `.env` file:

```sh
OPENROUTER_API_KEY=sk-or-...
```

Bring-your-own-key (BYOK) means the key is yours and stays with you. The tool reads it from the
environment at the moment of the call and nowhere else.

## Running on a local model with Ollama

Ollama needs no key. Install it, pull a model, and point the spec at it:

```sh
ollama serve          # starts the local server on :11434
ollama pull llama3.2
```

```yaml
model:
  provider: ollama
  name: llama3.2
  base_url: http://localhost:11434
```

`base_url` is only meaningful for Ollama. It's where the local server listens; omit it and the
default applies.

!!! warning "A missing Ollama server is a hard, visible error"
    If the Ollama server isn't reachable, the run fails loudly with a clear message. It will
    **never** silently fall back to a paid cloud API behind your back. The same holds for a
    missing or wrong cloud key: you get a specific error, not a mystery.

!!! note "Ollama inside Docker"
    When you run the canvas via `make up`, the container reaches your host's Ollama at
    `http://host.docker.internal:11434`, not `localhost`. Inside a container, `localhost` is the
    container itself. Running `kampong dev` directly (no Docker), use `http://localhost:11434`.

## Timeouts

A single model call that hangs shouldn't hang the whole run forever. `timeout_ms` caps how long
one call may take before the run aborts with a visible error:

```yaml
model:
  provider: openrouter
  name: liquid/lfm-2.5-2.6b:free
  api_key: ${OPENROUTER_API_KEY}
  timeout_ms: 30000
```

The default is 60 seconds. The CLI's `--timeout <ms>` flag overrides the spec value for one run,
which is handy for tuning a CI job without editing the file.

Next: give your agent something to do beyond talk, with [Adding tools](tools.md).
