# AgentSpec schema reference

The complete `AgentSpec` v1.0 format. The published JSON Schema
(`packages/spec/schemas/agent-spec.v1.0.schema.json`) is what your editor validates against; this
page is the human-readable companion. Where the two differ, the tool's own validator is the
authority.

## Top level

```yaml
version: "1.0"
agent:
  # ...
```

| Field     | Type   | Required | Notes                               |
| --------- | ------ | -------- | ----------------------------------- |
| `version` | string | yes      | `"1.0"` or `"1.1"`; see below.      |
| `vars`    | object | no       | Typed parameters (`"1.1"` only).    |
| `agent`   | object | yes      | The agent definition, below.        |

## Versions: `1.0` and `1.1`

The `version` decides how references and conditions are written. Nothing else changes.

- **`"1.0"`** keeps the original syntax: `{step.field}` and `{{ step.field }}` references, and the
  `<step_id>.<field> <op> <literal>` condition grammar. These keep validating and running. A 1.0 spec that
  uses a condition or a `{step.field}` placeholder gets a note (never an error) that `"1.1"` replaces them.
- **`"1.1"`** makes everything that computes a value a [JSONata](https://jsonata.org) expression: a
  condition's `if` is one (`$abs(trigger.change) >= vars.threshold`, with `=` for equality), and every
  `{{ … }}` in a tool or a step holds one. It also enables `vars`. A 1.1 spec is checked when it loads:
  a syntax error is reported with its line and the character in the expression, and so is a name nothing
  provides (a mistyped `vars.thresold`, a step that does not exist), because such a reference does not
  fail at run time, it silently reads as empty.

### Upgrading from the canvas

On a `"1.0"` spec the panels that need 1.1 (Vars, Trigger, Edit steps) say so and offer **Upgrade to 1.1…**.
It shows a line diff of exactly what would change and writes nothing until you press **Upgrade**. Changing
`version` alone would silently change a spec, so the upgrade also rewrites the two constructs 1.1 reads differently,
and lists each one:

- a `{step.field}` placeholder in a tool becomes `{{ step.field }}` (1.1 leaves `{...}` as text);
- a condition `step.field == "x"` becomes `step.field = "x"` (JSONata equality is `=`; `!=`, `>`, `>=`, `<`, `<=` are
  unchanged).

The result is loaded under the 1.1 rules first. If it would not load (a bare `{name}` placeholder, which 1.1 cannot
resolve without the step's name, or a condition that is not in the old grammar), nothing is changed and the reasons
are shown with their line numbers, so you fix them in the YAML and try again. The action is not offered in the hosted
app, which does not run 1.1 specs yet.

!!! note "Where a 1.1 spec runs"

    `kampong run`, `kampong dev` (the canvas test run), `kampong serve` and `kampong export` run a 1.1 spec.
    The hosted server does not yet (expressions on a shared server need isolation first) and refuses it by
    name. See `examples/incident-responder.yaml`.

### Expressions

Expressions read `trigger` (what started the run), `input` (the raw input text), `vars`, and the full
output of an earlier step by its step name (`review.findings[0].title`). `trigger` holds the webhook body's
fields at the top level (`trigger.alerts[0].id`), the whole body as `trigger.body`, and the request headers
as `trigger.headers` (lowercase names; headers that look like credentials are never passed). A body that is not
JSON is `trigger.body` as text. `kampong run` treats `--input` as the body, and takes `--header name=value`
for headers and `--var name=value` for vars. A step may not be named `trigger`, `input` or `vars`.

A value from the trigger goes into a URL as it arrives, so write `{{ $encodeUrlComponent(trigger.id) }}` for a
path or query part (a spec that does not is noted). Text from the trigger is never read as a `${ENV}` or
`{name}` reference: only what you wrote in the spec is. They are a pure function of that data: the clock and
random built-ins (`$now`, `$millis`, `$random`, `$shuffle`) and `$eval` are refused, and so are regular
expression literals. An expression is at most 4000 characters, and a run limits each one in time (1 second), depth, steps and the
size of what it builds, so a runaway expression fails its step instead of hanging the run.

At run time a `{{ expression }}` that is the whole of a field keeps the value's type (a number stays a number,
a list a list), so a component input can be filled with real data; inside other text it is written as text
(a string as is, a number or boolean as its text, anything else as JSON). One that selects nothing fails the
step, naming the expression. A condition must come out `true` or `false`: nothing, or any other type, fails
the step (`$exists(x)` tests whether a name is there, `$boolean(x)` tests truthiness).

On the canvas, every expression field in **Add step** (a condition, a branch's `if`, a transform's
values, a validate's `assert`, a dedupe's `key`, a foreach's `items`) checks what you type with the same parser
and the same name rule as the loader, so a problem shows as you type instead of on save, and it completes the
path you are typing: `vars.` lists the declared vars, `trigger.` its fields, and a step name its known outputs
(an `output_schema`'s properties, a transform's names). Press Ctrl+Space to list the roots. A `"1.0"` spec's
conditions are not expressions, so those fields stay plain text there.

### `vars`

```yaml
version: "1.1"
vars:
  threshold:
    type: number
    default: 5
  region:
    type: string
    default: "${REGION}"
  tickers:
    type: list
    items: string # string (the default) or number
    default: [AAPL, MSFT]
```

| Field         | Type                         | Required | Notes                                                                                  |
| ------------- | ---------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `type`        | `number`, `string` or `list` | yes      | What `vars.<name>` holds.                                                              |
| `items`       | `string` or `number`         | no       | For a list: what it holds (default `string`).                                          |
| `default`     | literal, or `"${ENV_VAR}"`   | no       | A literal of the declared type, or the name of an environment variable to read it from. |
| `description` | string                       | no       | For people.                                                                            |

An environment value is parsed as the declared type: a number must be finite, a list is a JSON array
(`["a","b"]`) or comma-separated (`a, b`). A var with no default must be given a value when the spec runs,
and a `${ENV_VAR}` default whose variable is unset or empty fails the run naming it; nothing is guessed.
Var names are letters, digits and underscores.

On the canvas, **Vars** (status bar) lists, adds, edits and removes them (not to be confused with **Secrets**, which
holds credentials outside the spec). Adding the first var creates the `vars:` block above `agent:`, and removing
the last takes the block with it. The panel is off for a `"1.0"` spec: 1.1 reads `{{ }}` references as
expressions, so the panel asks you to upgrade first (see [Upgrading from the canvas](#upgrading-from-the-canvas)).

## `agent`

| Field            | Type   | Required | Notes                                                                         |
| ---------------- | ------ | -------- | ----------------------------------------------------------------------------- |
| `id`             | string | yes      | Stable machine identifier. Names the exported project.                        |
| `name`           | string | yes      | Human-readable label.                                                         |
| `role`           | string | yes      | Who the agent is. Becomes part of the system instruction.                     |
| `goal`           | string | yes      | What the agent is trying to do. Becomes part of the system instruction.       |
| `model`          | object | no*      | Which model runs the agent. *Optional in the schema, but a real run needs it. |
| `tools`          | array  | no       | HTTP tools the workflow can invoke.                                           |
| `guardrails`     | object | no       | Confidence threshold and fallback.                                            |
| `knowledge_base` | array  | no       | Declared knowledge sources (see the note below).                              |
| `workflow`       | array  | yes      | Ordered steps. At least one.                                                  |
| `trigger`        | object | no       | How a deployed run starts: `webhook`, `schedule` or `poll` (see below).       |
| `approval_notifier` | object | no    | Where a headless run sends an approve/reject prompt (`type: slack`, `token`, `channel`). |

## `agent.trigger`

Three kinds: `webhook`, `schedule` and `poll`.

On the canvas, **Trigger** edits `agent.trigger` in place: pick a kind, fill the form, and the save is a patch
that leaves the rest of the file as it was. The form applies the loader's own rules, so a trigger it builds
always loads, and the errors name the field. A webhook takes its preset, authentication, response mode, `when`
and `map`; `when` and `map` are expression fields that read only `trigger` (the check and completion say so, and
`trigger.` lists `headers` and `body`). A schedule is a cron expression with a time zone, or an interval, and
says what to do on overlap. A poll takes the component, op and arguments, `items` and the item `id` (syntax is
checked; their names are the op's own), the dedupe rule and window. A secret is never typed in: a webhook names
the environment variable that holds it, and a poll's `secrets` are `${ENV_VAR}` placeholders. On a `"1.0"` spec
only a bare webhook is offered, and the panel offers to [upgrade](#upgrading-from-the-canvas) the spec first.

### `type: webhook`

A POST to `/webhook` on `kampong serve` (or an exported project's `npm run serve`) starts a run, and its
body becomes the input.

| Field        | Type    | Notes                                                                                              |
| ------------ | ------- | -------------------------------------------------------------------------------------------------- |
| `respond`    | string  | `async` (the default) or `sync`. Version 1.1 only.                                                  |
| `timeout_ms` | integer | With `respond: sync`, how long to wait, 1000 to 300000. Default 30000. Version 1.1 only.            |
| `preset`     | string  | `github`, `slack`, `alertmanager` or `generic`: expands to a concrete auth rule. Version 1.1 only.  |
| `auth`       | `none` or object | A `bearer` or `hmac` check, below. With a preset it supplies `secret_env` and may override any field but the type. |
| `when`       | string  | A JSONata condition over `trigger`. False means accepted but ignored (no run). Version 1.1 only.    |
| `map`        | object  | `name: expression` pairs that become `trigger.*`, replacing the body's fields. Version 1.1 only.    |

```yaml
trigger:
  type: webhook
  preset: github
  auth: { secret_env: GITHUB_WEBHOOK_SECRET }
  when: 'trigger.headers.`x-github-event` = "pull_request"'
  map:
    repo: "trigger.repository.full_name"
    number: "trigger.number"
```

**Auth.** `bearer` takes `secret_env`. `hmac` takes `header`, `algo` (`sha256` or `sha1`), `encoding` (`hex` or
`base64`), and optionally `prefix`, `timestamp_header`, `window_s` (default 300 with a timestamp header) and
`payload` (the signed text, with `{body}` and `{timestamp}`). `secret_env` is the _name_ of an environment
variable (`NAME` or `${NAME}`), never the secret. Signatures are checked over the raw request bytes with a
constant-time compare. Every failure, including an unset secret variable, answers `401 Unauthorized` and says
nothing about which check failed. The `slack` preset also answers Slack's `url_verification` challenge. With no
`auth` and no `preset` the webhook is open.

**Order.** authenticate, then `when`, then `map`, then the `respond` mode. An ignored request answers
`200 { success: true, ignored: true, reason }` and shows in `GET /triggers/ignored`. A `when` or `map` that
cannot be evaluated answers `422` and nothing runs. Headers that look like credentials are never in
`trigger.headers`.

#### Responding


With `respond: async` the POST answers `201` at once with a run id, and the caller polls
`GET /runs/<id>`. With `respond: sync` the POST is held open and answers with the result, for a caller that
wants an answer (a question-and-answer endpoint):

| The run...                                   | Status | Body                                                         |
| -------------------------------------------- | ------ | ------------------------------------------------------------ |
| completes                                    | `200`  | `{ success: true, id, output, state }`                        |
| fails                                        | `500`  | `{ success: false, id, error, state }`                        |
| is rejected                                  | `409`  | `{ success: false, id, error, state }`                        |
| pauses for approval                          | `202`  | `{ success: true, id, pending: "approval", state }`           |
| is still running when `timeout_ms` passes    | `202`  | `{ success: true, id, pending: "timeout", state }`            |

A `202` is not a failure: the run carries on, and `GET /runs/<id>` (and `POST /runs/<id>/approve`) work as
usual. A spec that needs a human to approve should expect `202` and tell its caller to poll.


### `type: schedule`

Starts a run on a clock while `kampong serve` is up (version 1.1 only). Exactly one of `cron` or `every`.

```yaml
trigger:
  type: schedule
  every: 6h # or: cron: "0 7 * * 1-5", tz: Asia/Singapore
  overlap: skip
```

| Field     | Type   | Notes                                                                                                     |
| --------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `cron`    | string | Five fields. `*`, lists, ranges, `a-b/n`, `*/n`, month and weekday names. A date that never exists is rejected. |
| `every`   | string | `30s`, `15m`, `6h`, `1d`; at least `1s`. Counts elapsed time from when `kampong serve` started.            |
| `tz`      | string | An IANA zone for `cron`. Default `UTC`. Not allowed with `every`.                                          |
| `overlap` | string | `skip` (default) drops a tick that comes due during a run; `queue` keeps one and runs it as soon as the current run ends. |

A scheduled run's input is the empty string, so read `vars` rather than `trigger`. A wall-clock time that does
not exist (a DST gap) runs once just after the gap; one that happens twice runs once. A schedule that must tick
every real hour regardless of the calendar should use `every`. `POST /schedule/run-now` starts a run
immediately and is refused, not queued, while another holds the lock.

!!! note "Exports"

    An exported project runs the schedule too: `npm run serve` (and the generated Dockerfile) starts the
    scheduler, with the same overlap lock, backoff and `POST /schedule/run-now`. `npm start` is a single run.
    Keep `.kampong/` on a volume so the lock and dedupe keys survive a restart.

### `type: poll`

Calls a connector op on an interval while `kampong serve` is up and starts one run per new item it returns
(version 1.1 only). A poll is for a source that cannot call you: an inbox, a list endpoint.

```yaml
trigger:
  type: poll
  every: 5m
  use: kampong/gmail-imap@1.0.0
  op: list_unseen
  with: { mailbox: INBOX }
  items: messages # the list inside the op's result
  id: uid # a key for one item
  dedupe: greatest
```

| Field              | Type    | Notes                                                                                                                              |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `every`            | string  | `30s`, `15m`, `6h`, `1d`; at least `1s`. The first poll runs as soon as `kampong serve` starts.                                    |
| `use`, `op`        | string  | The component (an exact `id@version`, pinned in `kampong.lock` like any other) and the op to call.                                 |
| `with`             | object  | The op's input, as written: `{{ }}` references are not resolved here, because no run exists yet.                                   |
| `config`, `secrets`| object  | As on a component tool. Secrets are `${ENV_VAR}` placeholders, never values.                                                       |
| `items`            | string  | An expression over the op's result that selects the list. Without it, the result itself must be a list.                            |
| `id`               | string  | An expression over one item giving its key: a non-empty string or a number. Required.                                              |
| `dedupe`           | string  | How a key becomes new, below. Required.                                                                                            |
| `window`           | string  | `time_window` only, same format as `every`: how long a key stays seen.                                                             |
| `one_run_per_item` | boolean | Default `true`. `false` starts one run over all the new items, with the list at `trigger.items` and as the input.                  |

| `dedupe`      | An item is new when                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `unique`      | its key was never seen. One small entry per key is kept forever.                                                          |
| `time_window` | its key was not seen within `window`. The entry expires with the window.                                                  |
| `greatest`    | its key is above the highest started so far (numbers by value, strings by code unit). Items start in ascending key order. |
| `last`        | it comes after the item that was last at the previous poll. The list must be oldest first. If that item has gone, every item is new. |

Each run reads its item as `trigger`: the item's fields at the top level (`trigger.subject`) and the whole item
as `trigger.body`. The state lives in `.kampong/state.db`, so a restart does not start an item again. A key is
remembered only once its run has started: if starting fails, the item comes back on the next poll. The first
poll starts every item the op returns, so point it at a source that holds only what you want handled (the
IMAP `list_unseen` op does, as long as the workflow ends with `mark_seen`).

A failed poll (the connector refused, the result was not a list, an `id` gave nothing) is reported and
retried with backoff, and stops `kampong serve` after repeated failures, like any recurring job.

!!! note "Exports"

    An exported project does not run a poll yet: `kampong export` refuses a spec with a poll trigger.

## `agent.model`

```yaml
model:
  provider: openrouter
  name: liquid/lfm-2.5-2.6b:free
  api_key: ${OPENROUTER_API_KEY}
  timeout_ms: 30000
```

| Field        | Type                                                | Required    | Notes                                                                                     |
| ------------ | --------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `provider`   | `anthropic` \| `openai` \| `ollama` \| `openrouter` | yes         | The model provider.                                                                       |
| `name`       | string                                              | yes         | Model name. For OpenRouter, usually vendor-prefixed (`anthropic/claude-3.5-haiku`).       |
| `api_key`    | `${ENV_VAR}` placeholder                            | conditional | Required for every provider except `ollama`. Must be an env placeholder, never a literal. |
| `base_url`   | URL                                                 | no          | Only meaningful for `ollama`: where the local server listens.                             |
| `timeout_ms` | positive integer                                    | no          | Max time for one model call. Default 60000. CLI `--timeout` overrides it.                 |

## `agent.tools[]`

```yaml
tools:
  - name: lookup_order
    action: http_request
    method: GET
    url: "https://api.shop.example/orders?ref={input}"
    extract: "order.status"
    requires_approval: false
```

| Field               | Type                                            | Required | Notes                                                                     |
| ------------------- | ----------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `name`              | string                                          | yes      | Referenced from a condition branch as `execute_tool(<name>)`.             |
| `action`            | `http_request`                                  | yes      | The generic HTTP tool. Other kinds: `component` (below), `slack_post_message`, `gmail_send`. |
| `method`            | `GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE` | yes      | HTTP method.                                                              |
| `url`               | string                                          | yes      | Endpoint. `{placeholders}` resolve from `{input}` and `{<step>.<field>}`. |
| `headers`           | map of string                                   | no       | Request headers. Credential-looking names must use `${ENV_VAR}`.          |
| `query`             | map of string                                   | no       | Query parameters, URL-encoded and appended to `url`.                      |
| `body`              | `json` \| `form` \| `raw`                        | no       | Exactly one encoding. Not allowed on `GET`.                               |
| `response`          | `{ mode: json \| text \| bytes }`               | no       | How the response is read. Defaults to `json`.                             |
| `failure_when`      | list of rules                                   | no       | Treat a matching `json` body as a failure, even on HTTP 200.              |
| `pace`              | `{ rps: number }`                               | no       | At most this many requests per second to the same host.                   |
| `retry`             | `{ max, backoff, base_ms, max_delay_ms }`       | no       | Re-attempt retryable failures with backoff.                               |
| `extract`           | string                                          | no       | Dotted path into the JSON response. Only valid for `json`.                |
| `requires_approval` | boolean                                         | no       | Pause for approval before the call.                                       |

### Component tools

```yaml
- name: store_row
  action: component
  use: kampong/supabase@1.0.0
  op: upsert
  config: { table: prices, on_conflict: "symbol,trade_date" }
  secrets: { api: "${SUPABASE_KEY}" }
  with: { rows: "{{ row }}" }
```

A component is a versioned, reusable connector. `use` is an exact `namespace/name@1.2.3`, `op` one of its
operations, `with` the op's input, `config` its non-secret per-use values (a `${ENV}` named like a credential
is rejected here), and `secrets` binds a declared auth slot to an environment variable. First-party components
live in `kampong/*`: `slack`, `gmail`, `github`, `supabase` and `alpha-vantage`. Anything else is pinned in
`kampong.lock` with `kampong lock`. Run `kampong doctor` to check one before a run.

### Headers, query, body and response

```yaml
- name: fetch_prices
  action: http_request
  method: GET
  url: "https://www.alphavantage.co/query"
  query:
    function: TIME_SERIES_DAILY
    symbol: "{{ input }}"
    apikey: "${ALPHAVANTAGE_KEY}"
  response:
    mode: json

- name: create_comment
  action: http_request
  method: POST
  url: "https://api.github.com/repos/{{ trigger.repo }}/issues/1/comments"
  headers:
    Authorization: "Bearer ${GITHUB_TOKEN}"
    Accept: application/vnd.github+json
  body:
    json:
      body: "{{ review.summary }}"
```

- **`body`** takes one of `json: {...}`, `form: {name: value}` or `raw: "text"` (with an optional
  `content_type`). A `Content-Type` is set for you unless you give one in `headers`.
- **`response.mode`**: `json` (default) parses the body, `text` returns it as a string (a GitHub
  diff is not JSON), and `bytes` returns it base64-encoded. `extract` only applies to `json`.
- **Secrets** go in as `${ENV_VAR}` and are resolved from the environment when the call is made.
  A header or query parameter whose name looks like a credential (`Authorization`, `Cookie`,
  anything containing `token`, `secret`, `password`, `api_key` and so on) is rejected if it is a
  literal. This is a check on the name only, so use `${ENV_VAR}` for every credential. `${...}` is
  expanded only in text you wrote in the spec, never in data from a model or a webhook.
- To write a literal `${NAME}` (a template, a code sample in a body), escape it as `$${NAME}`.
  Any other `${NAME}` in `url`, `headers`, `query` or `body` is an environment reference and fails
  the call if the variable is not set.
- A failed call never prints a resolved secret: it is redacted from error messages and recorded
  fixtures, including its percent-encoded, form-encoded and JSON-escaped spellings.

### Failures, pacing and retry

Some APIs report errors with HTTP 200. Alpha Vantage returns `{ "Note": "...5 calls per minute" }`
when rate limited, and Slack returns `{ "ok": false, "error": "channel_not_found" }`. `failure_when`
turns those into a visible failure:

```yaml
- name: fetch_prices
  action: http_request
  method: GET
  url: "https://www.alphavantage.co/query"
  query: { function: TIME_SERIES_DAILY, symbol: "{{ input }}", apikey: "${ALPHAVANTAGE_KEY}" }
  failure_when:
    - path: Note
      exists: true
      message_path: Note
      retryable: true # a rate limit is worth retrying
    - path: '["Error Message"]' # quote a key that contains a space
      exists: true
      message_path: '["Error Message"]'
  pace: { rps: 1 } # the free tier allows one request per second
  retry: { max: 3, backoff: exponential, base_ms: 1000, max_delay_ms: 20000 }
```

- **A rule** has a `path` and exactly one condition: `exists` (true or false), `equals`, or
  `matches` (a regular expression). Paths use dotted keys, `["quoted keys"]` and `[0]` indexes.
  `message_path` reads the reason shown in the error. Rules need a `json` response.
- **`retry`** re-attempts a failure only when it is retryable: HTTP 408, 429 and 5xx, a dropped
  connection, or a rule marked `retryable: true`. A 4xx such as 401 or 404 is never retried.
  `exponential` doubles `base_ms` each time. A `Retry-After` header is honoured when it is longer
  than the backoff, and if it asks for longer than `max_delay_ms` the call fails instead of waiting.
- **`POST` and `PATCH` are only retried on a 429, or when a rule you marked `retryable: true`
  matches.** After a 5xx or a dropped connection the request may already have been processed, and
  retrying could repeat the action.
- **`pace`** spaces requests to the same host, across concurrent steps and across retries. Tools that
  share a host are held to the slowest `rps` any of them declares.
- **`extract`** and `failure_when` use the same path syntax.
- A `200` whose body is not valid JSON counts as a (retryable) failure, not a crash.
- When retries run out the error says how many attempts were made.

## `agent.guardrails`

```yaml
guardrails:
  confidence_threshold: 0.7
  fallback_action: escalate_to_human
```

| Field                  | Type                | Required | Notes                                                                   |
| ---------------------- | ------------------- | -------- | ----------------------------------------------------------------------- |
| `confidence_threshold` | number 0–1          | no       | Below this, the guardrail fires on a `confidence_gate` step.            |
| `fallback_action`      | `escalate_to_human` | no       | What to do when it fires. The one supported action pauses for approval. |

## `agent.workflow[]`

At least one step. A step is an action step, a condition step, or one of the kinds below. Everything except
`action`, `condition`, `tool` and `approval` needs `version: "1.1"`; on a 1.0 spec the validator names the step
kind and the line of the field.

### Action step

```yaml
- step: greet
  action: generate_text
  inputs: [input]
  query: "Answer concisely."
  confidence_gate: false
```

| Field             | Type     | Required | Notes                                                                        |
| ----------------- | -------- | -------- | ---------------------------------------------------------------------------- |
| `step`            | string   | yes      | Unique step name.                                                            |
| `action`          | string   | yes      | Descriptive label; today every action step is a model generation.            |
| `inputs`          | string[] | no       | Field names flagged as relevant to the model.                                |
| `query`           | string   | no       | Extra per-step instruction for the model.                                    |
| `confidence_gate` | boolean  | no       | Return a structured `{ result, confidence }` and enable the guardrail check. |
| `output_schema`   | object   | no       | A JSON Schema subset. The model must return exactly this object, which is validated (one retry) and becomes the step's output. Version 1.1. |
| `instructions`    | string   | no       | Replaces the role and goal as this step's system prompt. Version 1.1.        |
| `model`           | string   | no       | A different model of the same provider for this step. Version 1.1.           |
| `temperature`     | number   | no       | Sampling temperature, 0 to 2. Version 1.1.                                    |

#### Lines and tools on the canvas

The trigger and the steps run down one column, in run order, and each line joins a step to the next one. A line
that would pass behind a step (a branch going on to the step after its arms) is drawn round it instead. Tools sit in
a column to the left of the run. Hover or focus a tool and the steps that call it get an outline; hover or focus a
step and the tools it calls get one. A line's accessible name uses the steps' names ("Line from anomaly to report
(else)"), never internal ids. Positions on the canvas are not part of the spec.

#### The top bar and the status bar

The canvas has a **top bar** with the workflow's name (and **← Specs** in hosted mode), whether it is **Saved**
(or "Saves paused" while the YAML has an error), **Run** (opens Test Run), the `</>` button for the YAML drawer
and a **⋮** menu. The menu holds what is not used on every edit: **Add step**, **Add tool**, **Edit steps** (the
list for renaming, reordering and deleting steps and tools), **Import YAML** and **Export YAML**. A step is also
added from the palette on the left or the + on a line, and **+ Tool** under the palette adds a tool. The **status
bar** along the bottom holds the workflow's settings, each opening its panel: **Vars**, **Secrets** (with the
number of names the workflow reads that have no value yet), **Guardrails**, **Checks** and **Trigger**. Neither bar
overlaps at 480 pixels wide or more.

#### Test Run: Replay or Live

**Run** opens Test Run, which has a **Replay / Live** switch (local mode). **Replay** answers every tool,
connector and model call from recorded fixtures, so it needs no keys and no network and shows the recorded
results; it is the default whenever fixtures exist, in `.kampong/fixtures` or in a `fixtures/` folder beside the
spec (the `market-etl` template ships them). **Live** calls the real services. It shows a red **LIVE** banner
listing each tool the run would call and whether it only reads or changes something outside the project, and a
live run with a tool that changes things asks you to confirm before it starts. Which tools change things comes
from the HTTP method (anything but GET or HEAD) or, for a component, the `effect` of the operation. The result
states the mode it ran in, **Replay (recorded fixtures)** or **LIVE**. With no fixtures only Live is offered. The
hosted server cannot replay yet, so hosted mode shows no switch and runs as before.

The local server backs this with `GET /api/run-options` (the modes open to the spec, the fixtures found and the
tools a live run would call) and a `mode` (`replay` or `live`, default `live`) on `POST /api/runs`, whose response
repeats the mode that ran. A replay with no fixtures is refused with 409.

A spec that declares `vars` (version 1.1) gets a **Vars** group in Test Run: one field per var, prefilled with its
default (a list as comma-separated text). Edit one to run with a different value, the same as `kampong run --var
name=value`: only the vars you changed are sent, as `vars` on `POST /api/runs` (text, parsed as the declared type,
so a value that is not a number for a `number` var fails the run and names the var), and the spec file is not
touched. A var named in `vars` but not declared in the spec is refused with 400. `GET /api/run-options` lists the
declared `vars` with their defaults. Hosted mode shows no var fields yet, because the hosted server does not run
1.1 specs.

A run that finishes but carried failed items on (a `foreach` with `on_error: continue`) is shown as an amber
**completed with N errors**, not a green **completed**. A table lists each failed item with the step that failed
and its message, and the full output sits in a collapsed **Full output** section below it. A run with no failed
items stays green and shows its output as before.

#### Selecting a node on the canvas

Click a node (or Tab to it and press Enter) to open it in the side panel. The panel shows the same form as the
menu: the step forms of **Edit steps** for every kind of step (action, tool, approval, transform, validate,
dedupe, stop, foreach, branch, including a foreach's body steps and a branch's arms), the tool form for a tool node,
the **Trigger** form for the trigger node and the guardrails form for the guardrails node. A condition step, or a
step on a `"1.0"` spec, has no form; its panel says so and still offers Delete and Duplicate. Each node has an
accessible name (for example "Transform step scratch, in loop") and a focus ring, and the selected node is outlined.

The trigger node says what starts a run: `Manual` when the spec has no trigger, `Schedule: every 6h` (or
`Schedule: cron 0 9 * * 1-5`), `Webhook (GitHub)` (the preset, if any) or `Poll: every 5m`. It updates when the
trigger is saved. A long step name is cut with an ellipsis inside its node (the full name is the tooltip and the
accessible name), and a workflow of more than 15 nodes gets a minimap in the corner: drag in it to pan, scroll to zoom.

| Key | What it does |
| --- | --- |
| `Esc` | Closes the panel and puts focus back on the node. Closes the delete confirm first when it is open. |
| `Delete` | Deletes the selected step or tool after the usual confirm (outside a text field). A step or tool that something still uses is refused and the places are listed. |
| `Ctrl+D` / `Cmd+D` | Duplicates the selected step or tool as `<name>_copy` (then `_copy2`...). The copy sits right after the original in the same list, a copied foreach or branch gets new names for the steps inside it, and the copy is selected. |

### Command palette and shortcuts

`Ctrl+K` / `Cmd+K` opens the command palette from anywhere on the canvas (also from the run bar's menu, **Search
commands**). It is a dialog with a search box and a list; type to filter, `Up` and `Down` move, `Enter` runs, `Esc`
closes it, and focus goes back to where it was. It lists the canvas's own actions (Run (Test Run), Open code (YAML
drawer), Open Secrets / Vars / Checks / Guardrails / Trigger, Add step, Add tool, Edit steps, Import YAML, Export
YAML) and a **Go to** entry for the trigger, guardrails and every step and tool, which selects the node and opens
its inspector as a click does. If the panel has typed input that is not saved, the same "Discard changes?" prompt
asks first. `/` is separate: it focuses the step search in the left palette.

| Key | What it does |
| --- | --- |
| `Ctrl+K` / `Cmd+K` | Opens or closes the command palette. |
| `/` | Focuses the step search in the left palette (outside a text field). |
| `Alt+Y` | Opens or closes the YAML drawer. |

Every step form and the tool form sit in one shell with four tabs. **Setup** holds the few fields most people need,
**Settings** the rest (for a model step the temperature, shown as **Creativity (temperature)**; for a foreach the
concurrency and what to do when an item fails; for an HTTP tool the headers, body, response and extract field).
**Output** and **Test** will show what the step produced and received on the last run; until a run has happened they
say "Run the workflow to see output" and show nothing else. One **Save** saves every tab, and what is typed on a
tab is kept when you switch. The tabs follow the ARIA tabs pattern: `Left` and `Right` (wrapping), `Home` and `End`
move between them, and `Tab` goes on to the open panel. Fields are labelled in task words (for example **What
should the model do?**, **Tool to call**, **List to go through**, **If an item fails**); the spec field behind each
is unchanged.

The panel also has **Duplicate** and **Delete** buttons. Clicking another node, the empty canvas, a status bar button or a menu action
while a form has input you have not saved asks first ("Keep editing" or "Discard changes"); saving or cancelling
closes the panel without asking. Selecting a node replaces any docked panel, and a status bar button or menu action replaces the node's
panel. **Duplicate** and **Delete** are not offered on the trigger and guardrails nodes.

On the canvas, **Edit steps** (in the top bar's **⋮** menu) lists every step (a branch's arms and a foreach's body included) and opens an action
step in place: its query, instructions, model and temperature (blank keeps the agent's), and an `output_schema` tree
editor with nested objects, arrays, enums and `required`. The form refuses what the loader refuses (an object with
no properties, an array with no items, a `confidence_gate` step without a required numeric `confidence`), keywords
the form has no field for (`pattern`, `format`, `default`, ...) are kept as written, and a save patches only the fields that
changed. A `"1.0"` spec's steps are not editable this way, and the panel offers to [upgrade](#upgrading-from-the-canvas) the spec first.

A transform, validate or dedupe step opens the same way, with the expression fields that check syntax and names as
you type (a step in a foreach can read its loop variable). A save is refused while an expression would not load,
and replaces only the fields that changed, so comments elsewhere in the step survive. On the canvas these nodes
carry a line under the title: a transform's value names, a validate's assertion (clipped) and `on_fail`, and a
dedupe's key and `ttl`.

A foreach's body steps are nodes of their own on the canvas, set in from the loop and joined in run order
(loop, each body step, then the step after the loop). A foreach opens in **Edit steps** with its `items`, loop
variable, `concurrency` and `on_error` (`fail`, `continue` or `retry`; an `on_error: goto` is left as written).
**Add step** (the menu action, or a kind chosen in the palette) has an **Add to** choice: pick a loop, or an arm of a branch (`then`, `else`, a case or the
`default`), to add a step of any kind there, and a **Position** choice in plain words and step names (_At the end
of each_symbol_, _At the start of anomaly (else)_, _After fetch_). While you choose, the canvas shows a dashed
"New step goes here" marker beside the node the step will land next to, and after the save the new node is panned
into view and flashed. Underneath it is a `step.insert` at a place with an `index`, the same call on the local and
the hosted server. An `else` or `default` that is not there yet is created. An
approval in a loop, a nested foreach, or a step after a stop is refused by the spec, and the form shows that message.

The canvas has two faster ways in to the same form. The **step palette** on the left lists the kinds in three
groups (do work, work with data, control the flow), each with a one-line description; type to search (the search also
knows words such as _loop_ or _if_), press `/` anywhere outside a text field to jump to it, use the arrow keys and
`Enter` to choose, and the form opens with that kind at the end of the workflow. On a narrow window the palette starts
as a **Steps** button and opens over the canvas. A **+** on a line between two steps (it shows when you hover the
line; with the keyboard, focus the line and press `Enter`) opens the same picker, and the form opens with **Add to**
and **Position** already set to just before the step the line leads to: between two steps, at the start of a loop's
body, or at the start of a branch arm. The save is a single `step.insert`, so the YAML changes by one inserted block.
`Esc` closes the picker.

A branch's arms are nodes of their own the same way: each arm step is set in from its branch and marked with the arm
it is in, the branch leads to the first step of each arm on a line labelled `then`, `else`, `case <value>` or
`default`, and every arm that does not end in a stop leads on to the next step (a missing `else`, or no matching
case, goes straight on). A branch opens in **Edit steps** with its `if` condition or its `switch` value; its arms
are edited, deleted and added to as steps. In the Add form, **Branch on** a value builds a `switch`: one
`value: step: tool` line per step (repeat a value for more steps in a case) and an optional default. Adding a new
case to an existing switch is done in the YAML for now.

A tool step opens with a picker over the agent's tools, a stop step with its `reason` and `status` (clearing a
field removes it from the file), and an approval step with its `message`; these also work on a `"1.0"` spec except
`stop`, which is 1.1 only. Loops, branches and condition steps have no form here yet and say so in their row. Below the
steps, **Edit steps** lists the agent's tools, each with an **Edit** button that opens the Add Tool form on the saved
values. The tool's name, kind and (for a component) component and operation are fixed, because changing them is a
rename or a different tool. A component's operation inputs show as fields; an input the form cannot show, or a
component that is not installed, is edited as YAML. Fields the form has no control for (an HTTP tool's `failure_when`,
`pace` and `retry`; `requires_approval` on a Slack or Gmail tool; an input the op does not declare) are kept as written.

### Condition step

```yaml
- step: route
  type: condition
  if: 'classify.category == "weather"'
  then: "execute_tool(get_weather)"
  else: "request_human_approval"
```

| Field  | Type        | Required | Notes                                                                                                    |
| ------ | ----------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `step` | string      | yes      | Unique step name.                                                                                        |
| `type` | `condition` | yes      | Marks this as a condition step.                                                                          |
| `if`   | string      | yes      | `<step_id>.<field> <op> <literal>`; ops `== != > >= < <=`; literals `true`/`false`/number/quoted string. In a `"1.1"` spec: a JSONata expression. |
| `then` | string      | yes      | Branch when true: `execute_tool(<name>)` or `request_human_approval`.                                    |
| `else` | string      | yes      | Branch when false: same two options.                                                                     |

### Tool and approval steps

```yaml
- step: notify
  type: tool
  tool: post_to_slack # a name from agent.tools
- step: sign_off
  type: approval
  message: "Send {{ draft.text }}?"
```

A `tool` step always runs its tool. An `approval` step pauses for a human; a rejection ends the run as
`rejected`.

### Data steps: `transform`, `validate`, `dedupe`

Version 1.1. Each field that holds an expression is a whole JSONata expression, checked when the spec loads.

```yaml
- step: shape
  type: transform
  set:
    change: "($number(latest.close) - $number(previous.close)) / $number(previous.close) * 100"
- step: sane
  type: validate
  assert: "$exists(shape.change)"
  on_fail: skip # fail (default) | skip
  message: "no price for {{ symbol }}"
- step: once
  type: dedupe
  once: { key: "trigger.id", ttl: "24h" }
```

- **`transform`** `set: { name: expression }`: the output is the object of values (`shape.change`). Every
  expression reads the data as it was before the step. A value that selects nothing fails the step, naming the
  field.
- **`validate`** `assert` must be `true` or `false`. On failure, `fail` ends the run as failed with `message`;
  `skip` ends it as completed with `skipped: { step, reason }` and nothing after it runs. `on_fail: branch` is
  refused; use a `branch` with a `stop`.
- **`dedupe`** claims `key` in the state store for `ttl` (`30s`, `15m`, `6h`, `7d`). The first run to claim it
  continues; any other ends as completed with `skipped`. The claim is atomic across processes and survives a
  restart. It is open while the run is going (held for at most 15 minutes, so a crashed process frees it), becomes
  held for the full `ttl` when the run completes (or ends as `skipped`), and is released if the run fails or is
  rejected, so a retry is not swallowed. Inside a `foreach` the same applies to each item. A run paused on a
  persisted approval keeps its key for the `ttl`, even if it fails after being resumed. A run that finds the key
  open elsewhere is skipped and not retried automatically; the next tick or redelivery will. The store is SQLite at
  `.kampong/state.db`.

### `foreach`

Version 1.1. Runs a nested list of steps once per item of a list.

```yaml
- step: each_symbol
  foreach:
    items: "vars.symbols" # a whole expression that gives a list
    as: symbol # the loop variable
    concurrency: 2 # 1 to 32, default 1
    on_error: continue # fail (default) | continue | { retry: { n, backoff, base_ms, max_delay_ms, then } }
    steps:
      - step: fetch
        type: tool
        tool: fetch_price
```

The body takes any step kind except another `foreach` and an approval. Expressions in the body read the loop
variable and the body steps that ran before them. The step's output is `{ results, errors, skipped, count }`:
`results` holds one object of body outputs per item that completed, `errors` is `{ index, item, step, message }`
for each isolated failure, `skipped` the items a `validate` skip, a `dedupe` duplicate or a `stop` ended (inside a
loop these end the item, not the run), and `count` how many items there were. `items` that is not a list, or
selects nothing, fails the step. `on_error: goto` is refused.

### `branch` and `stop`

Version 1.1. `branch` chooses between lists of steps, in two forms. An arm can hold any step, including another
`branch` or a `foreach`.

```yaml
- step: route
  branch:
    if: "triage.confidence > 0.8" # true or false
    then:
      - step: answer
        type: tool
        tool: reply
    else: # optional
      - step: hand_off
        type: approval
- step: route_by_label
  branch:
    switch: "classify.label" # string, number or boolean, compared as text
    cases:
      duplicate:
        - step: ignore
          stop: { reason: "duplicate {{ trigger.id }}" }
    default: # optional
      - step: answer
        type: tool
        tool: reply
```

`stop: { reason?, status? }` ends the run successfully. `status` is `skipped` (the default: the run completes with
`skipped: { step, reason }`) or `completed` (no `skipped`). Inside a `foreach` body a `stop` ends only that item.
The `condition` step above is unchanged, and is the right choice for a 1.0 spec.

## `agent.knowledge_base[]`

```yaml
knowledge_base:
  - type: url
    source: "https://docs.example.com/policy"
```

| Field    | Type                     | Required | Notes                                                              |
| -------- | ------------------------ | -------- | ------------------------------------------------------------------ |
| `type`   | `pdf` \| `url` \| `text` | yes      | Kind of source.                                                    |
| `source` | string                   | yes      | Path, URL, or literal text.                                        |
| `mode`   | `inject`                 | no       | Put this source in the prompt of every action step. Version 1.1.   |

## Using a source: `mode: inject`

```yaml
version: "1.1"
agent:
  knowledge_base:
    - type: text
      mode: inject
      source: "A duplicate charge is reviewed by billing within 3 business days."
    - type: url
      mode: inject
      source: "https://docs.example.com/policy"
```

An `inject` source is loaded once at the start of a run and added to the system prompt of every action
step, after that step's `instructions` (or the agent's role and goal). The model is told the material is data
and to ignore any instructions inside it.

- `text` is used as written. `url` is fetched with a GET (http or https only), and a web page is reduced to its
  text. Both go through the same fetch as tools, so `--tools record` and `--tools replay` cover a `url`.
- Size is capped: 20,000 characters from one source and 60,000 across all of them. A cut is marked in the text
  the model sees, and sources past the total are named as left out. Put the most important source first.
- A source that cannot be loaded (a 404, a timeout, an empty page) fails the run before the first step,
  naming the source. The model never answers without material it was meant to have.
- `pdf` cannot be injected yet: `mode: inject` on a `pdf` source is a validation error.
- `kampong doctor --online` reaches the host of an injected `url`.

A source with no `mode` is only declared: nothing reads it. `kampong run`, `serve` and `export` print a
warning on stderr when one is declared, and the canvas shows a banner, so it is never ignored silently.

## Secrets rule

`model.api_key` accepts only the exact form `${ENV_VAR}` (a name starting with a letter or
underscore). A literal value fails validation before any run or export. This is enforced by the
schema, so a spec can never carry a real secret.
