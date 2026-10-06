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
| `version` | string | yes      | Spec format version. `"1.0"` today. |
| `agent`   | object | yes      | The agent definition, below.        |

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
| `action`            | `http_request`                                  | yes      | The only tool kind in v1.                                                 |
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

At least one step. Each is either an action step or a condition step.

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
| `if`   | string      | yes      | `<step_id>.<field> <op> <literal>`; ops `== != > >= < <=`; literals `true`/`false`/number/quoted string. |
| `then` | string      | yes      | Branch when true: `execute_tool(<name>)` or `request_human_approval`.                                    |
| `else` | string      | yes      | Branch when false: same two options.                                                                     |

## `agent.knowledge_base[]`

```yaml
knowledge_base:
  - type: url
    source: "https://docs.example.com/policy"
```

| Field    | Type                     | Required | Notes                       |
| -------- | ------------------------ | -------- | --------------------------- |
| `type`   | `pdf` \| `url` \| `text` | yes      | Kind of source.             |
| `source` | string                   | yes      | Path, URL, or literal text. |

!!! note "Declared, not yet executed"
    `knowledge_base` is part of the spec schema so specs can express it forward-compatibly, but
    the v1 execution engine does not retrieve or inject these sources into a run yet. Include it
    to document intent; don't expect it to change behavior today. `kampong run`, `serve` and
    `export` print a warning on stderr when it is declared, and the canvas shows a banner, so it
    is never ignored silently.

## Secrets rule

`model.api_key` accepts only the exact form `${ENV_VAR}` (a name starting with a letter or
underscore). A literal value fails validation before any run or export. This is enforced by the
schema, so a spec can never carry a real secret.
