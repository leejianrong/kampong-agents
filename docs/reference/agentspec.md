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
| `extract`           | string                                          | no       | Dotted path into the JSON response, e.g. `order.status`.                  |
| `requires_approval` | boolean                                         | no       | Pause for approval before the call.                                       |

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
    to document intent; don't expect it to change behavior today.

## Secrets rule

`model.api_key` accepts only the exact form `${ENV_VAR}` (a name starting with a letter or
underscore). A literal value fails validation before any run or export. This is enforced by the
schema, so a spec can never carry a real secret.
