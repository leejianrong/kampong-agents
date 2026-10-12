// KAN-1850: a version 1.1 spec that uses every field the canvas forms write: vars, a webhook trigger with a
// preset, `when` and `map`, an action step with instructions, model, temperature and an output_schema, and an
// http_request tool with headers, query, a json body, failure_when, pace and retry.
//
// Written so a canvas save leaves it alone: no long scalars (the serializer re-folds those, KAN-2139) and block
// maps rather than flow maps.
export const VALID_FIXTURE_CANVAS_FORMS = `# Alert triage (version 1.1: the fields the canvas forms write)
version: "1.1"
vars:
  # how many alerts one run looks at
  max_alerts:
    type: number
    default: 20
  region:
    type: string
    description: Which region to watch
    default: sg
agent:
  id: alert-triage
  name: "Alert triage"
  role: "On-call triager"
  goal: "Summarise firing alerts and page when one is severe."
  trigger:
    type: webhook
    preset: alertmanager
    auth:
      secret_env: ALERT_TOKEN
    when: "trigger.body.status = 'firing'"
    map:
      alerts: "trigger.body.alerts"
  tools:
    - name: page
      action: http_request
      method: POST
      url: "https://pager.example.com/v2/page"
      headers:
        Authorization: "Bearer \${PAGER_TOKEN}"
      query:
        region: "{{ vars.region }}"
      body:
        json:
          summary: "{{ triage.summary }}"
      response:
        mode: json
      failure_when:
        - path: ok
          equals: false
          retryable: false
      pace:
        rps: 2
      retry:
        max: 3
        backoff: exponential
  workflow:
    - step: triage
      action: summarise_alerts
      instructions: "Be brief."
      model: small-model
      temperature: 0.2
      output_schema:
        type: object
        properties:
          summary:
            type: string
          severe:
            type: boolean
        required:
          - summary
          - severe
    - step: notify
      type: condition
      if: "triage.severe"
      then: page_oncall
      else: done
`;
