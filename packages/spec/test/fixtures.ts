// Shared fixture specs for @kampong/spec's test suite.

export const VALID_FIXTURE = `# Refund processing agent
version: "1.0"
agent:
  id: refund-agent
  name: "Customer Refund Agent"
  role: "Customer Support Specialist"
  goal: "Review incoming refund requests and process eligible ones."
  tools:
    - name: check_stripe_charge
      action: http_request
      method: GET
      url: "https://api.stripe.com/v1/charges/{charge_id}"
  guardrails:
    confidence_threshold: 0.85
    fallback_action: escalate_to_human
  workflow:
    - step: parse_request
      action: extract_entities
      inputs: [customer_email, order_id]
`;

export const VALID_FIXTURE_WITH_CONDITION = `version: "1.0"
agent:
  id: refund-agent
  name: "Customer Refund Agent"
  role: "Customer Support Specialist"
  goal: "Review incoming refund requests and process eligible ones."
  tools:
    - name: check_stripe_charge
      action: http_request
      method: GET
      url: "https://api.stripe.com/v1/charges/{charge_id}"
    - name: issue_refund
      action: http_request
      method: POST
      url: "https://api.stripe.com/v1/refunds"
      requires_approval: true
  guardrails:
    confidence_threshold: 0.85
    fallback_action: escalate_to_human
  workflow:
    - step: parse_request
      action: extract_entities
      inputs: [customer_email, order_id]
    - step: evaluate_policy
      action: check_knowledge
      query: "Is {order_id} eligible for refund?"
    - step: handle_approval
      type: condition
      if: "evaluation.eligible == true"
      then: "execute_tool(issue_refund)"
      else: "request_human_approval"
`;

export const VALID_FIXTURE_WITH_MODEL = `version: "1.0"
agent:
  id: refund-agent
  name: "Customer Refund Agent"
  role: "Customer Support Specialist"
  goal: "Review incoming refund requests and process eligible ones."
  model:
    provider: anthropic
    name: claude-3-5-haiku-latest
    api_key: \${ANTHROPIC_API_KEY}
  tools:
    - name: issue_refund
      action: http_request
      method: POST
      url: "https://api.stripe.com/v1/refunds"
      requires_approval: true
  guardrails:
    confidence_threshold: 0.85
    fallback_action: escalate_to_human
  workflow:
    - step: parse_request
      action: extract_entities
      inputs: [customer_email, order_id]
    - step: evaluate_policy
      action: check_knowledge
      query: "Is {order_id} eligible for refund?"
      confidence_gate: true
    - step: handle_approval
      type: condition
      if: "evaluate_policy.eligible == true"
      then: "execute_tool(issue_refund)"
      else: "request_human_approval"
`;

// KAN-1185: exercises the optional `agent.model.timeout_ms` field alongside
// the rest of a model config, so the round-trip suite covers it too.
export const VALID_FIXTURE_WITH_TIMEOUT = `version: "1.0"
agent:
  id: refund-agent
  name: "Customer Refund Agent"
  role: "Customer Support Specialist"
  goal: "Review incoming refund requests and process eligible ones."
  model:
    provider: anthropic
    name: claude-3-5-haiku-latest
    api_key: \${ANTHROPIC_API_KEY}
    timeout_ms: 15000
  workflow:
    - step: parse_request
      action: extract_entities
      inputs: [customer_email, order_id]
`;

export const VALID_FIXTURE_NO_TOOLS = `version: "1.0"
agent:
  id: greeter
  name: "Greeter Agent"
  role: "Front Desk"
  goal: "Greet visitors."
  guardrails:
    confidence_threshold: 0.5
  workflow:
    - step: greet
      action: say_hello
`;

// KAN-1840: a version "1.1" spec: vars, expressions in a condition and in a `{{ }}` template.
export const VALID_FIXTURE_V1_1 = `# Incident responder (version 1.1: expressions and vars)
version: "1.1"
vars:
  threshold:
    type: number
    default: 5
    description: "Alert when the change is at least this big"
  region:
    type: string
    default: "\${REGION}"
  tickers:
    type: list
    items: string
    default: [AAPL, MSFT]
agent:
  id: responder
  name: "Incident Responder"
  role: "On-call engineer"
  goal: "Look up the alert and decide whether to page someone."
  tools:
    - name: lookup
      action: http_request
      method: GET
      url: "https://x.test/{{ $encodeUrlComponent(trigger.id) }}?r={{ vars.region }}"
  workflow:
    - step: triage
      action: classify
    - step: decide
      type: condition
      if: "$abs(trigger.change) >= vars.threshold and $count(trigger.alerts) > 0"
      then: "execute_tool(lookup)"
      else: "request_human_approval"
`;

// KAN-1860: transform, validate and dedupe steps (version 1.1).
export const VALID_FIXTURE_DATA_STEPS = `# Nightly price move report (version 1.1: data steps)
version: "1.1"
vars:
  threshold:
    type: number
    default: 5
agent:
  id: price-report
  name: "Price Report"
  role: "Market analyst"
  goal: "Report large price moves once."
  workflow:
    - step: fetch
      action: fetch_prices
    - step: seen
      type: dedupe
      once:
        key: "trigger.symbol & '-' & fetch.day"
        ttl: 24h
    - step: check
      type: validate
      assert: "fetch.open > 0"
      on_fail: skip
      message: "open price must be positive"
    - step: shape
      type: transform
      set:
        change: "(fetch.close - fetch.open) / fetch.open * 100"
        big: "$abs((fetch.close - fetch.open) / fetch.open * 100) >= vars.threshold"
        top: "$sort(fetch.items, function($a, $b) { $a.n < $b.n })[[0..1]]"
        label: "$join(fetch.tags, ', ')"
`;
