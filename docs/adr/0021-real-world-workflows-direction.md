# ADR-0021: Real-world workflows direction (V9) and the workflow-model extension

- Status: Accepted
- Date: 2026-09-16
- Deciders: Jian (product owner)

## Context

V1–V4 shipped a deliberately narrow single-agent spec: a linear list of steps where each action
step is a model generation, tools fire **only** from inside a condition step's `then`/`else`
(`packages/engine/src/workflow.ts` is a single linear `for` over the step list), the only tool
kind is `http_request`, `knowledge_base` is in the schema but not executed, and a run starts only
from a manual input. That is far short of what people actually build with LangGraph, Mastra, and
n8n (agentic tool-loops, branching/parallel/loops, RAG, real app connectors, event triggers,
human-in-the-loop, multi-agent).

A planning interview (2026-09-16) chose the near-term direction, prioritized **ahead of finishing
V5 hosting** (V5 is parked as demo-ready until actually deployed). The bet is deliberately scoped,
not "do everything".

## Decision

**Direction: Mastra-style structured workflows, single-agent, that plug into the real world.**

- **Mastra-style, not LangGraph-style, first.** Grow the workflow toward Mastra's workflow
  primitives (sequence, branch, parallel, loops, suspend/resume for human-in-the-loop, data
  mapping). Mastra is already the export target, so this keeps the canvas↔YAML duality (ADR-0002)
  and the one-way export / no-lock-in guarantee central. Cyclic graphs and agentic tool-loops
  (the LangGraph model) are a larger execution-model rebuild, deferred.
- **Single-agent, go deep first** (ADR-0001 holds). Multi-agent org-charts stay V7.
- **North-star hero: support triage & auto-reply** — classify an incoming message, look up context
  via an API, draft a reply, get human approval, send. Every slice below is justified by making
  this hero real, demoable, and deployable.
- **Deployable without the hosted SaaS auth stack.** Connector credentials are `${ENV}` tokens
  (e.g. `${SLACK_BOT_TOKEN}`), the same secrets model as BYOK model keys — no OAuth dance, no
  user-auth platform required. The deployable artifact is the **exported standalone Mastra app**
  (the exporter is extended to emit the webhook listener, connector calls, and the Slack-button
  approval callback), or `kampong serve <spec>` for a quick demo. Export stays the deployable
  artifact, preserving no-lock-in.

### The workflow-model extension (Slice A, the load-bearing schema change)

Two new workflow step kinds are added to the `type`-discriminated `workflowStepSchema`, alongside
the existing action step (no `type`) and condition step (`type: condition`):

- **Tool step** (`type: tool`): call a tool as a normal step, not only from an `if` branch.
- **Approval step** (`type: approval`): a first-class human-in-the-loop pause, not only a
  condition-branch outcome. Reuses the engine's existing approval/resume machinery.

And **data references** `{{ step.field }}` / `{{ trigger.field }}` / `{{ input }}`, resolvable in
an action step's `query`, a tool step's params, and an approval step's `message`. This is additive
and backward-compatible: existing action/condition steps and the existing `{placeholder}` URL
resolution keep working; unifying the two reference syntaxes is a later cleanup, not this slice.

The hero workflow in the extended model:

```yaml
version: "1.0"
agent:
  id: support_triage
  name: "Support Triage"
  role: "Front-line support agent"
  goal: "Triage an incoming support message and draft a correct, on-brand reply."
  model:
    provider: openrouter
    name: liquid/lfm-2.5-2.6b:free
    api_key: ${OPENROUTER_API_KEY}
  tools:
    - name: get_order
      action: http_request
      method: GET
      url: "https://api.shop.example/orders/{{ classify.order_id }}"
      extract: order
    - name: send_reply
      action: http_request # Slice B: becomes a Slack/Gmail connector
      method: POST
      url: "https://api.helpdesk.example/tickets/{{ trigger.ticket_id }}/reply"
  workflow:
    - step: classify # action step (model): structured output
      action: classify
      query: "Classify this message. Return { category, urgency, order_id }."
      confidence_gate: true
    - step: lookup # tool step (new): always runs, not gated on a condition
      type: tool
      tool: get_order
    - step: draft # action step (model), referencing prior outputs
      action: generate_text
      query: "Draft a reply for a {{ classify.category }} request about {{ lookup.order }}."
    - step: review # approval step (new): first-class human gate
      type: approval
      message: "Approve this {{ classify.category }} reply?"
    - step: send # tool step (new)
      type: tool
      tool: send_reply
```

### Slice sequence (V9, one board card each: KAN-1429..1432)

- **A. Workflow model core** (KAN-1429): the schema/engine/canvas/exporter changes above. Demo:
  the hero built on the canvas with generic HTTP, run with a pasted message, approved in the
  canvas modal.
- **B. Connectors** (KAN-1430): Gmail + Slack connector tool kinds (creds via `${ENV}`), keeping
  `http_request`. Demo: posts to a real Slack channel / sends a real email.
- **C. Webhook trigger + serve/deploy** (KAN-1431): `agent.trigger` (webhook first); `kampong
  serve <spec>` and the exported app expose the endpoint that starts a run per event. Demo: a real
  webhook event drives the flow on a deployed process.
- **D. Headless approval via Slack buttons** (KAN-1432): a paused deployed run posts an
  Approve/Reject Slack message; the click resolves the run. Demo: end-to-end real.

## Alternatives considered

| Option | Why not (now) |
| ------ | ------------- |
| LangGraph-style cyclic, stateful, multi-agent graphs first | The most powerful, but the biggest rebuild of the execution model (cycles, agentic tool-loops, supervisor/worker). Deferred; revisit after the Mastra-style single-agent model and the real-world hero are proven. |
| n8n-style integration breadth (hundreds of connectors) first | The moat is breadth, which is a huge, ongoing surface. Ranked second by the product owner; we take the two connectors the hero needs (Gmail, Slack) and the generic HTTP tool rather than chasing breadth up front. |
| Finish V5 hosting before this | Hosting isn't deployed and was explicitly deprioritized. This direction reaches a demoable/deployable product faster and via export, without the multi-tenant auth stack. |
| Full hosted execution for triggers/approval | Not required. `kampong serve` + the exported app cover deploy without the SaaS auth/RLS stack; connector and approval creds are `${ENV}` tokens. |

## Consequences

- The `AgentSpec` grows new step kinds, a data-reference syntax, connector tool kinds, and an
  `agent.trigger`. Each is additive; existing specs keep validating and running.
- The exporter becomes the deployment story: it must emit the webhook listener, connector calls,
  and the Slack approval callback so the exported app is a real deployable service. This deepens
  the exporter's behavioral-equivalence test surface.
- Headless approval introduces an out-of-band decision channel (Slack interaction payloads), the
  one genuinely new real-world integration point; it must verify Slack's request signatures.
- V5 hosting cards (KAN-1408/1427/1393/1389) stay open and parked; V9 is sequenced ahead of them.
- Multi-agent (V7), loops/parallel, and RAG execution remain future work; the schema is shaped to
  admit them without breaking V9 specs.
