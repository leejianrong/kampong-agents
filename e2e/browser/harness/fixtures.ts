import type { ModelClient } from "@kampong/engine";

// Shared deterministic fixtures for the browser E2E harness (KAN-1228
// follow-up). The same tool-requires-approval spec + fake ModelClient + canned
// fetch the server's own runs-approval integration test uses
// (packages/server/test/integration/routes/runs-approval.test.ts), so a run
// started from the real canvas UI pauses at a HITL approval gate and completes
// once approved -- with no network call and no real provider key. The BYOK key
// the UI stores is exercised as a UI step; the run itself uses this fake model
// (the `createModel` seam bypasses per-workspace BYOK resolution), which is
// what keeps the browser test deterministic and offline.

/** Eligible refund -> the condition routes to execute_tool(issue_refund). */
export function fakeModel(): ModelClient {
  return {
    async generateText() {
      return "ok";
    },
    async generateStructured<T>() {
      return { result: { eligible: true }, confidence: 0.99 } as T;
    },
  };
}

/** The tool's http_request never really fires -- this canned Response stands in. */
export const fetchImpl = (async () =>
  new Response(JSON.stringify({ status: "refunded" }), { status: 200 })) as unknown as typeof fetch;

/**
 * A spec whose `issue_refund` tool has `requires_approval: true`, reached via a
 * condition step -- so a run of it deterministically pauses at an approval gate.
 * Seeded into the workspace by the E2E test so the canvas can open, run, and
 * approve it.
 */
export const TOOL_APPROVAL_SPEC = `version: "1.0"
agent:
  id: refund-agent
  name: "Refund Agent"
  role: "Support"
  goal: "Process refunds."
  tools:
    - name: issue_refund
      action: http_request
      method: POST
      url: "https://api.stripe.test/v1/refunds"
      requires_approval: true
      extract: status
  workflow:
    - step: parse_request
      action: extract_entities
      confidence_gate: true
    - step: decide
      type: condition
      if: "parse_request.eligible == true"
      then: "execute_tool(issue_refund)"
      else: "request_human_approval"
`;
