# CLI reference

The `kampong` command has three subcommands. Run `kampong <command> --help` for the same
information at the terminal.

```
kampong dev [dir]                          Start the local canvas server.
kampong run <spec>.yaml --input "<text>"   Run a spec headlessly.
kampong export <spec>.yaml <output-dir>    Eject a spec to a standalone TypeScript project.
```

## `kampong dev`

Starts the local Fastify server: a spec-CRUD API, a server-sent-events stream of file-change and
run-progress events, and the built canvas UI, all at one `http://<host>:<port>` origin.

```sh
kampong dev [dir] [options]
```

| Argument / option | Default      | Description                                             |
| ----------------- | ------------ | ------------------------------------------------------- |
| `[dir]`           | `.`          | Directory holding the spec and its `.kampong/` sidecar. |
| `--spec <file>`   | `agent.yaml` | Spec filename within `[dir]`.                           |
| `--port <n>`      | `4310`       | Port to listen on.                                      |
| `--host <host>`   | `localhost`  | Host to bind.                                           |
| `-h`, `--help`    |              | Show help.                                              |

Requires a build first (`npm run build`), because it serves the compiled canvas assets. Stop it
with Ctrl+C.

## `kampong run`

Runs a spec against the execution engine with no server and no browser. Designed to run fully
offline with `--tools replay` and an Ollama model.

```sh
kampong run <spec>.yaml --input "<text>" [options]
```

| Argument / option  | Default                        | Description                                                                                               |
| ------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `<spec>.yaml`      |                                | Path to the spec file to run. Required.                                                                   |
| `--input "<text>"` |                                | The run's input text. Required.                                                                           |
| `--json`           | off                            | Emit one machine-readable JSON object on stdout instead of a human summary.                               |
| `--tools <mode>`   | `live`                         | `live` (real calls), `record` (call once, save a fixture), or `replay` (fixture only, never the network). |
| `--fixtures <dir>` | `<spec dir>/.kampong/fixtures` | Where fixtures are read and written for record and replay.                                                |
| `--approve-all`    | off                            | Auto-approve every pause instead of prompting on stdin. For CI.                                           |
| `--timeout <ms>`   | `60000`                        | Max milliseconds for a single model call before the run aborts. Overrides the spec's `model.timeout_ms`.  |
| `-h`, `--help`     |                                | Show help.                                                                                                |

### Approval prompt

Without `--approve-all`, a paused run prompts on stdin. Answer `y`/`yes` to approve; anything else
rejects. Reject with a reason via `n:<reason>`, like `n:looks risky`.

## `kampong export`

Exports a spec to a standalone, runnable Mastra TypeScript project with zero dependency on this
tool. It's one-way: the result is never re-imported.

```sh
kampong export <spec>.yaml <output-dir> [options]
```

| Argument / option | Default | Description                                                         |
| ----------------- | ------- | ------------------------------------------------------------------- |
| `<spec>.yaml`     |         | Path to the spec file to export. Required.                          |
| `<output-dir>`    |         | Directory to write the project into (created if missing). Required. |
| `--force`         | off     | Overwrite the output directory even if it exists and is non-empty.  |
| `-h`, `--help`    |         | Show help.                                                          |

Run the result with `cd <output-dir> && npm install && npm start`.

## Exit codes

Every command shares the same exit-code vocabulary, so a script can tell the failure modes apart.

| Code | Meaning                                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success.                                                                                                                                                                      |
| `1`  | Spec validation failure: malformed YAML or a schema violation.                                                                                                                |
| `2`  | Execution failure: the run couldn't start or failed mid-way (a missing key, an unreachable Ollama, a failed tool call, or an approval rejection), or an export write failure. |
| `64` | Usage error: a bad flag or a missing required argument.                                                                                                                       |
