# Kampong Agents: Slices

Vertical increments. Each ends in something you can demonstrate. Slice 1 confronts the riskiest unknown: whether canvas↔YAML duality can actually be lossless.

**Cross-cutting note:** any frontend/UI work in any slice below (canvas app, property panels, guardrail controls, hosted V5 UI) uses Material Design 3 (`/material-design-3`) rather than ad hoc styling.

## V1: Canvas ↔ YAML Duality

**Delivers:** R0, R1, R5

**Build plan**

1. Define the trimmed single-agent `AgentSpec` YAML schema (role/goal, tools, guardrails, workflow steps) and its JSON Schema validator (S1).
2. Build the sidecar layout store (`.kampong/layout.json`) keyed by step/tool ID (ADR-0006).
3. Build the canvas web app's read path: parse a spec + layout file, render blocks (Trigger → Tools → Workflow → Guardrails) at their stored (or auto-laid-out) positions.
4. Build the canvas write path: every canvas mutation (add/edit/remove a block, rewire a connection) re-serializes through the validator back to the YAML file and updates the layout file.
5. Build the tool-definition form (structured: name, HTTP method, URL with `{placeholders}`, response-extraction path) as the "Add Tool" affordance, with zero LLM calls required (Q12, R5).
6. Add the file-watcher: detect external changes to the YAML while the canvas has it open, prompt to reload (Q10).
7. Add the split-screen YAML preview panel.

**Demo:** Build a two-step agent (one tool defined via the structured form, one conditional guardrail branch) entirely on the canvas; show the live YAML preview updating as you build. Then open the YAML file in a plain text editor, hand-edit a field, save, and watch the canvas prompt to reload and re-render correctly with no data loss.

**Rests on assumptions:** Q9 (sidecar layout file) — if wrong, layout data needs migrating into the spec format later. Q6 (local web app) — if wrong, this slice's UI would need porting to a desktop shell.

### Test plan

#### End-to-end

- Building a 2-step agent on canvas produces a YAML file that validates against the schema and matches an expected fixture.
- Hand-editing that YAML file externally and reloading the canvas re-renders it with all blocks, connections, and properties intact.

#### Integration

- Round-trip property test: for a corpus of fixture specs (varying tool counts, conditional depths), `parse → render → re-serialize` produces byte-for-byte-equivalent YAML (modulo key ordering) to the original.
- Layout store correctly assigns auto-layout positions to a node with no existing sidecar entry.

#### Unit

- Schema validator rejects malformed specs with a specific field/line-level error.
- Each canvas node type serializes to and deserializes from its corresponding YAML fragment correctly.
- Tool-definition form produces a valid tool spec fragment from structured input alone, with no LLM call involved.

## V2: Local Execution Engine + Guardrail/HITL

**Delivers:** R2

**Build plan**

1. Build the Mastra-backed execution engine (S3): map `AgentSpec` role/goal to a Mastra agent's system instruction, tools to Mastra tool definitions (HTTP request wrapper), workflow steps to sequential execution with conditional branching.
2. Implement `requires_approval` as a blocking step: browser modal when triggered from a canvas test-run, CLI stdin prompt when triggered from a headless run.
3. Implement the confidence-threshold guardrail check and its `fallback_action` (escalate to approval).
4. Wire BYOK: read the model/provider config and API key (via `${ENV_VAR}`) from the spec and environment (Q14).
5. Add the in-canvas "test run" panel showing step-by-step execution state.

**Demo:** Run the V1 agent from the canvas against a live LLM call and a real HTTP tool call; trigger the guardrail (input crafted to cross the confidence threshold), see the run pause with an approval modal, approve it, and see the run complete with a visible per-step trace.

**Rests on assumptions:** Q5 (MVP must execute, not just design) — this slice is the direct payoff of that assumption. Q11 (blocking local prompt for HITL) — if a customer needs async/remote approval before hosted mode, this needs revisiting sooner than planned. Q8 (no silent model fallback).

### Test plan

#### End-to-end

- Running the V1 fixture agent against a live (or realistic-fixture) LLM + tool call completes successfully and produces the expected final output.
- An input crafted to cross the guardrail threshold pauses the run and requires explicit approval before continuing; rejecting the approval halts the run with a clear status.

#### Integration

- Execution engine correctly evaluates the `if/then/else` condition syntax from the spec against real step outputs.
- Missing/invalid API key produces a clear, specific error rather than a generic failure.

#### Unit

- Guardrail confidence-threshold comparison logic is correct at and around the boundary value.
- Tool-call HTTP wrapper correctly substitutes `{placeholders}` and extracts the configured response field.

## V3: Local-First Dev Experience — CLI, Mock Tools, Ollama

**Delivers:** R3, R6

**Build plan**

1. Build `kampong dev` (starts the local server + canvas) and `kampong run <spec>.yaml --input "..."` (headless execution, JSON output, exit codes) (S5).
2. Build the mock/record tool layer (S4): first real call is recorded to a local fixture file; subsequent runs in "mock mode" replay it deterministically with no network call.
3. Build the Ollama adapter as an alternate model provider alongside BYOK cloud providers.
4. Enforce zero required network calls and zero default telemetry when running fully in mock+Ollama mode.

**Demo:** With network disabled, run the V2 agent fully offline via `kampong run` using a local Ollama model and a previously recorded mock tool response; confirm output matches the V2 live-run output on the same input, with zero network calls made (verified via a network monitor or firewall rule during the demo).

**Rests on assumptions:** Q8 (no silent fallback) — this slice is where that guarantee is actually exercised and verified.

### Test plan

#### End-to-end

- `kampong run` against a mock-recorded spec, fully offline (network disabled), completes and matches the expected fixture output.
- `kampong dev` starts a working local canvas server reachable at `localhost` with no external network dependency for the UI itself.

#### Integration

- Recording a tool call once and replaying it in mock mode produces identical results across multiple replay runs (determinism).
- Ollama adapter surfaces a clear, specific error when the local model server isn't running — never a silent fallback to a cloud provider.

#### Unit

- CLI exit codes are correct for success, validation failure, and execution failure cases.
- CLI output is valid, parseable JSON when requested.

## V4: TypeScript Export ("Eject")

**Delivers:** R4

**Build plan**

1. Build the codegen pipeline (S6): `AgentSpec → standalone Mastra TypeScript project` (package.json, agent definition, tool definitions, guardrail/approval logic, a runnable entry point).
2. Ensure the exported project has zero dependency on the Kampong Agents tool itself — only on Mastra and its own declared dependencies.
3. Add `kampong export <spec>.yaml <output-dir>` to the CLI.

**Demo:** Export the V2 fixture agent; in a clean directory with no reference to this tool, run `npm install && npm start` in the exported project; confirm it produces output behaviorally identical to the canvas/CLI-run version on the same fixed input.

**Rests on assumptions:** ADR-0002 (one-way export) — hand-editing the exported project and expecting it to sync back to canvas is explicitly unsupported; this must be documented, not just silently absent.

### Test plan

#### End-to-end

- Exported project, installed and run standalone (no access to the original tool or spec file), produces output matching the canvas-run version on the same fixed input.

#### Integration

- Exported project's `package.json` declares only real, resolvable dependencies (no phantom/internal-only packages).
- Guardrail/approval logic in the exported code triggers under the same conditions as the in-tool execution engine.

#### Unit

- Codegen correctly translates each spec construct (tool, conditional, guardrail) into its TypeScript equivalent.

---

## Roadmap (post-MVP, sequenced by customer pull, not built upfront)

These are real commitments on the roadmap per product direction — not "someday maybe" — but are intentionally lower-detail here since their design depends on what V1–V4 usage actually reveals.

## V5: Hosted / BYOK SaaS Mode

**Delivers:** R7

**Build plan**

1. Deploy the same canvas web app (S2) multi-tenant, backed by a real backend instead of the local filesystem (accounts, workspaces, per-workspace spec storage).
2. Add workspace-scoped BYOK key storage (encrypted at rest).
3. Introduce an LLM gateway (e.g. LiteLLM or a hosted equivalent) for cross-provider failover/retry, now that shared infrastructure makes this a real reliability concern (revisits ADR-0004).
4. Add hosted execution (the same S3 engine, now running server-side per workspace).

**Demo:** Sign up, paste an API key, build and run an agent entirely in the browser with no local install.

**Rests on assumptions:** Q6/ADR-0005 (canvas as a reusable web app) — this slice is the direct payoff of that decision; a desktop app choice in V1 would have blocked this entirely.

### Test plan

#### End-to-end

- A new hosted account can build, run, and export an agent through the browser with no local tool installed.

#### Integration

- Gateway failover correctly reroutes on a simulated provider outage without failing the user's run.

#### Unit

- Per-workspace key storage is encrypted at rest and inaccessible cross-workspace.

## V6: Enterprise Governance

**Delivers:** R8

**Build plan**

1. SSO/SCIM (SAML/OIDC) for hosted workspaces.
2. RBAC roles: Agent Creator, Agent Operator, Compliance Auditor, Tool Manager.
3. PII scrubbing middleware and egress policy rules (e.g. "no SQL DELETE," "no emails outside @company.com").
4. Immutable, SIEM-exportable audit logs (structured JSON, per-run).
5. Per-run cost/token circuit breakers and department-level cost attribution.

**Demo:** An admin configures SSO via an identity provider, invites a user with the Compliance Auditor role (read-only), and that user can view an audit log entry for a real run but cannot edit or run agents.

**Rests on assumptions:** Requires V5 (hosted mode) as a prerequisite — none of this is meaningful in a single-user local tool.

### Test plan

#### End-to-end

- A Compliance Auditor-role user can view audit logs and cannot create, edit, or execute agents.
- An SSO-provisioned user can log in without a separate local password.

#### Integration

- Egress policy rules block a disallowed tool action (e.g., an email to a domain outside the allowlist) before it executes.
- A run exceeding its configured cost limit halts mid-execution and is logged as such.

#### Unit

- Audit log entries are structurally valid against the documented schema for SIEM ingestion.
- Cost-limit comparison logic correctly halts at the configured threshold.
