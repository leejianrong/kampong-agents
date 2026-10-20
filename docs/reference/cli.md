# CLI reference

The `kampong` command has seven subcommands. Run `kampong <command> --help` for the same
information at the terminal.

```
kampong dev [dir]                          Start the local canvas server.
kampong run <spec>.yaml --input "<text>"   Run a spec headlessly.
kampong serve <spec>.yaml                  Run a spec as a live webhook / scheduled / polling service.
kampong export <spec>.yaml <output-dir>    Eject a spec to a standalone TypeScript project.
kampong templates [--json]                 List the ready-made specs you can copy and edit.
kampong doctor <spec>.yaml                 Preflight a spec: components, pins, credentials, fixtures.
kampong lock <spec>.yaml [--update]        Pin the components a spec uses to their content digests.
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

**No spec yet is a new workflow, not an error.** In an empty folder (or with `--spec` naming a file
that does not exist) the canvas opens an empty state with **Start blank**. Choosing it writes a valid
minimal spec with the `yaml-language-server` schema pragma; until then nothing is written. A file
that exists but cannot be read is still reported as an error. A spec with `workflow: []` shows
"This workflow has no steps yet" with an **Add step** button, and Run says why it cannot start.
While the YAML is broken, the canvas keeps the last valid version, names the line to fix and says
saves are paused.

**Saves are confirmed.** After each save the canvas shows a short "Saved: ..." message (announced to
screen readers), flashes the node that changed, and, when the YAML drawer is open, scrolls it to the
changed lines and marks them for a few seconds. The drawer is never opened for you, and with
`prefers-reduced-motion` the marking is a still colour with no animation.

**Typed input is not lost silently.** Vars, Trigger, Edit Steps and Secrets keep their draft while
you open another panel and are as you left them when you come back. `Esc` (or Close) closes the open
panel at once when nothing is typed; with typed input it asks "Keep editing / Discard changes", and
Discard is what drops the draft. The other forms (Add Tool, Add Workflow Step, Guardrails, Edit Tool
and a node's inspector) ask the same question before another panel or node replaces them.

## `kampong run`

Runs a spec against the execution engine with no server and no browser. Designed to run fully
offline with `--tools replay`: tool, connector and model calls all answer from recorded fixtures.

```sh
kampong run <spec>.yaml --input "<text>" [options]
```

| Argument / option  | Default                        | Description                                                                                               |
| ------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `<spec>.yaml`      |                                | Path to the spec file to run. Required.                                                                   |
| `--input "<text>"` |                                | The run's input text. Required.                                                                           |
| `--json`           | off                            | Emit one machine-readable JSON object on stdout instead of a human summary.                               |
| `--tools <mode>`   | `live`                         | `live` (real calls), `record` (call once, save a fixture), or `replay` (fixture only, never the network). |
| `--model <mode>`   | follows `--tools`              | `live`, `record` or `replay` for model calls alone. `--model live` keeps a real model under `--tools replay`. |
| `--fixtures <dir>` | `<spec dir>/.kampong/fixtures` | Where fixtures are read and written for record and replay (tools, connectors and model calls).             |
| `--var <name=value>` |                              | A value for one of the spec's `vars` (version 1.1). Repeatable; wins over the var's default.              |
| `--header <name=value>` |                            | A request header a webhook would have carried, read as `trigger.headers`. Repeatable.                      |
| `--approve-all`    | off                            | Auto-approve every pause instead of prompting on stdin. For CI.                                           |
| `--timeout <ms>`   | `60000`                        | Max milliseconds for a single model call before the run aborts. Overrides the spec's `model.timeout_ms`.  |
| `-h`, `--help`     |                                | Show help.                                                                                                |

### Approval prompt

Without `--approve-all`, a paused run prompts on stdin. Answer `y`/`yes` to approve; anything else
rejects. Reject with a reason via `n:<reason>`, like `n:looks risky`.

## `kampong serve`

Runs a spec as a long-lived service: the self-host and deploy path. The same engine and spec as
`kampong run`, but the process stays up and a run starts when the spec's trigger fires.

```sh
kampong serve <spec>.yaml [--port <n>] [--host <host>]
```

| Option          | Default   | Description                |
| --------------- | --------- | -------------------------- |
| `--port <n>`    | `8080`    | Port to listen on.         |
| `--host <host>` | `0.0.0.0` | Host or interface to bind. |

| Endpoint                    | What it does                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST /webhook`             | Start a run; the body is the input. Auth, `when` and `map` apply first (see the `webhook` trigger).     |
| `GET /runs/:id`             | The run's current state.                                                                               |
| `GET /runs/:id/events`      | Server-sent events stream of the run's progress.                                                       |
| `POST /runs/:id/approve`    | Resolve a paused run: `{ "approved": boolean, "reason"?: string }`.                                    |
| `POST /schedule/run-now`    | Start a scheduled spec's run now. `409` if a run holds the lock, `404` if the spec has no schedule.    |
| `GET /triggers/ignored`     | The latest 100 webhook requests that `when` ignored.                                                   |
| `GET /healthz`              | Liveness check.                                                                                        |

A spec with a `schedule` or `poll` trigger is driven by the unattended runner: one run at a time with an overlap
lock, jitter and backoff, and a visible failure limit. Pending approvals are persisted and survive a
restart. Model keys and connector tokens resolve from this process's environment.

## `kampong templates`

Lists the ready-made specs that ship with kampong: complete folders to copy and edit. Each holds an
`agent.yaml`, a `README.md` and, when it can run offline, recorded `fixtures/`.

```sh
kampong templates [--json]
```

`--json` prints an array of `{ name, description, path }`. The command copies nothing; copy the folder
yourself. Today there are two: `market-etl`, a scheduled price pipeline (see
[Scheduled data pipelines](../tutorial/pipelines.md)), and `support-triage`, an inbox assistant that drafts replies.

## `kampong doctor`

Checks a spec before you run it: that its components resolve and are pinned, what permissions they ask
for, and that each credential's environment variable is set (names only, never values).

```sh
kampong doctor <spec>.yaml [--tools replay] [--fixtures <dir>] [--online] [--probe] [--json]
```

| Option             | Description                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `--online`         | Also open a TCP connection to each host the spec's components, tools and injected URLs may reach.   |
| `--probe`          | Check each credential is accepted, by calling the read-only probe op its component declares.        |
| `--tools replay`   | Check fixtures as `kampong run --tools replay` would use them, including that model answers exist.  |
| `--fixtures <dir>` | Fixture directory (default `<spec dir>/.kampong/fixtures`).                                         |
| `--json`           | One JSON object: `{ ok, checks: [{ status, area, message }] }`.                                     |

## `kampong lock`

Pins every component a spec uses (`action: component`) to its content digest in `kampong.lock`, next to the
spec. A run refuses a component that is not pinned or whose files no longer match the pin. First-party
`kampong/*` components do not need a pin.

```sh
kampong lock <spec>.yaml [--update] [--allow-wider-permissions]
```

`--update` accepts a changed component and re-pins it. `--allow-wider-permissions`, with `--update`, also
accepts one that may now do more than when it was pinned (a new host, environment variable, file access, or
a secret reaching a new host). Without it such an update is refused and the widening is listed.

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
