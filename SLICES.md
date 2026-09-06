# Kampong Agents: Slices

Vertical increments. Each ends in something you can demonstrate. Slice 1 confronts the riskiest unknown: whether canvas↔YAML duality can actually be lossless.

**Cross-cutting notes:** any frontend/UI work in any slice below (canvas app, property panels, guardrail controls, hosted V5 UI) uses Material Design 3 (`/material-design-3`) rather than ad hoc styling. The stack is React + Vite + `@xyflow/react` for the canvas, Fastify + SSE for the local server, and the `yaml` package for comment-preserving parsing (ADR-0007) — external editing (Cursor, agentic coding tools) is a first-class workflow, not an edge case (ADR-0008).

## V1: Canvas ↔ YAML Duality

**Delivers:** R0, R1, R5

**Build plan**

1. Define the trimmed single-agent `AgentSpec` YAML schema (role/goal, tools, guardrails, workflow steps) and its JSON Schema validator (S1).
2. Build the sidecar layout store (`.kampong/layout.json`) keyed by step/tool ID (ADR-0006).
3. Build the canvas web app's read path: parse a spec + layout file, render blocks (Trigger → Tools → Workflow → Guardrails) at their stored (or auto-laid-out) positions.
4. Build the canvas write path: every canvas mutation (add/edit/remove a block, rewire a connection) re-serializes through the validator back to the YAML file and updates the layout file.
5. Build the tool-definition form (structured: name, HTTP method, URL with `{placeholders}`, response-extraction path) as the "Add Tool" affordance, with zero LLM calls required (Q12, R5).
6. Add the file-watcher: auto-reload on an external change by default (no prompt); surface a prompt only in the rare case of a local mutation still in flight when the external write lands (Q10, ADR-0008).
7. Add the split-screen YAML preview panel (React + `@xyflow/react` for the canvas itself, per ADR-0007).
8. Publish the `AgentSpec` JSON Schema (S7) and wire the `yaml-language-server` pragma into spec files, so a spec authored in Cursor or by an agentic coding tool gets real validation/autocomplete with zero setup (ADR-0008).

**Demo:** Build a two-step agent (one tool defined via the structured form, one conditional guardrail branch) entirely on the canvas; show the live YAML preview updating as you build. Then, separately, hand-write or agent-generate a spec file in a plain text editor / Cursor / Claude Code with no prior canvas involvement, point `kampong dev` at that folder, and watch it render on the canvas immediately with no import step. Edit that same file externally again while the canvas is open and watch it auto-reload with no prompt.

**Rests on assumptions:** Q9 (sidecar layout file) — if wrong, layout data needs migrating into the spec format later. Q6/ADR-0007 (local web app, React + `@xyflow/react`) — if wrong, this slice's UI would need porting to a desktop shell or a different graph library. Q10/ADR-0008 (auto-reload by default) — if this reads as data-lossy to real users, an explicit confirmation step needs adding back.

### Test plan

#### End-to-end

- Building a 2-step agent on canvas produces a YAML file that validates against the schema and matches an expected fixture.
- A spec file written entirely outside the app (no canvas involvement) renders correctly on the canvas the moment `kampong dev` opens that folder — zero import step.
- Editing that YAML file externally while the canvas has it open auto-reloads it with no prompt, re-rendering with all blocks, connections, and properties intact; comments and formatting in the original file survive the round trip.

#### Integration

- Round-trip property test: for a corpus of fixture specs (varying tool counts, conditional depths, and hand-written comments), `parse → render → re-serialize` produces byte-for-byte-equivalent YAML (modulo key ordering) to the original, including preserved comments (ADR-0007's `yaml`-package choice).
- Layout store correctly assigns auto-layout positions to a node with no existing sidecar entry.
- A local mutation in flight when an external write lands surfaces the conflict prompt instead of silently auto-reloading (the one case ADR-0008 does NOT auto-resolve).

#### Unit

- Schema validator rejects malformed specs with a specific field/line-level error.
- Each canvas node type serializes to and deserializes from its corresponding YAML fragment correctly.
- Tool-definition form produces a valid tool spec fragment from structured input alone, with no LLM call involved.
- The published JSON Schema artifact validates a corpus of both valid and intentionally-invalid fixture specs correctly (this is what external editors/agentic tools rely on, so it needs its own direct test, not just indirect coverage via the in-app validator).

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

**Scoped by:** ADR-0013 (hosting/deployment/gateway topology), ADR-0014 (database & multi-tenancy
model), ADR-0015 (auth & account model), ADR-0016 (BYOK secret custody). Deploys to a self-hosted
k3s homelab cluster as a real multi-tenant SaaS with public signup (not a private/internal-only
deployment) — every design choice below assumes untrusted strangers will have accounts.

**Build plan**

1. Scaffold `packages/server`: a new Fastify app (new workspace package alongside `packages/cli`,
   `packages/spec`, `packages/engine`, `packages/exporter`) reusing `packages/spec` and
   `packages/engine` unchanged. Containerize it (single image bundling built `apps/canvas` assets +
   API, per ADR-0013); check in a Helm chart at `deploy/helm/kampong-server/`.
2. Stand up Postgres on k3s via the CloudNativePG operator, with scheduled backups to
   S3-compatible object storage configured from day one (ADR-0013) — not added after the fact.
3. Wire `drizzle-kit` migrations and the initial schema (`workspaces`, `workspace_members`,
   `specs`, `layouts`; ADR-0014) into a deploy-time Kubernetes `Job`.
4. Define the `SpecRepository` interface and refactor `packages/cli`'s `SpecStore` to implement it
   against the filesystem (paying down the gap ADR-0014 identified: this interface was implied by
   ADR-0005 but never actually built); add a Postgres-backed implementation for `packages/server`.
5. Add Postgres Row-Level Security policies on every tenant-scoped table, keyed on a per-request
   `app.workspace_id` session variable set by request-handling middleware (ADR-0014).
6. Integrate Better Auth (Drizzle adapter) into `packages/server`: email+password and GitHub OAuth
   sign-in, session cookies, the `organization` plugin for workspace/member modeling (ADR-0015).
   Adopt the `sso` plugin now (dormant, activated in V6).
7. Wire authenticated, workspace-scoped versions of the existing spec-CRUD routes
   (`/api/spec`-equivalent) against the new `SpecRepository` + RLS, reusing `packages/spec`'s
   validator unchanged.
8. Point `apps/canvas`'s already-origin-agnostic API client (`createApiClient(baseUrl)`) at the
   hosted server; add auth-aware request handling (session cookie forwarding, a login screen) —
   the first and only canvas-side change this slice requires, confirming ADR-0005's "one UI
   codebase" design.
9. Build workspace-scoped BYOK key storage: the `byok_keys` table (ADR-0014), app-level
   AES-256-GCM envelope encryption under a root key held only in a Kubernetes `Secret` (ADR-0016),
   and a masked key-management UI/API (add/replace/delete a key; never display or return a
   decrypted value).
10. Deploy self-hosted LiteLLM as its own cluster Deployment (ADR-0013); point the hosted
    `ModelClient` resolution path (the DB-backed successor to `createMastraModelClient`,
    decrypting a workspace's key via ADR-0016 at call time) at LiteLLM's internal service address
    instead of calling providers directly.
11. Add hosted execution: replace `RunManager`'s in-memory `Map` with a durable `runs` table
    (ADR-0014); wire the existing `AgentRun`/`runWorkflow` engine (unchanged) to run server-side per
    workspace, with SSE run-progress streaming and the browser-modal approval path both scoped to
    the authenticated user's workspace.
12. Add cross-tenant-isolation tests (a new test shape this repo hasn't needed before) proving RLS
    actually blocks cross-workspace reads even under a maliciously-crafted query.

**Demo:** Sign up (email+password or GitHub), create a workspace, paste a real provider API key,
build an agent entirely in the browser with no local install, and run it — the run executes
server-side against the pasted key (relayed through the self-hosted LLM gateway), with the same
step-by-step trace and approval-modal UX V2 already built, now backed by durable, workspace-scoped
storage instead of local files and an in-memory run map.

**Rests on assumptions:** Q6/ADR-0005 (canvas as a reusable web app) — this slice is the direct
payoff of that decision, confirmed concretely by how little `apps/canvas` itself needs to change
(build plan step 8). ADR-0007's Postgres placeholder — this slice is where that assumption becomes
a real, ADR-graded decision (ADR-0014). The homelab/k3s hosting choice (ADR-0013) means backup/DR
and public-network exposure are first-class concerns from step 2 onward, not deferred hardening.

### Test plan

#### End-to-end

- A new hosted account can sign up, create a workspace, build an agent on the canvas, paste a BYOK
  key, and run it to completion through the browser with no local tool installed.
- A guardrail-triggering run pauses with a browser approval modal, is approved, and completes —
  the same V2 acceptance test, now proven against the hosted execution path.
- Restoring the CNPG-managed Postgres backup into a fresh cluster recovers all workspace/spec/run
  data (a real restore drill, not just a configured backup schedule).

#### Integration

- RLS cross-tenant-isolation test: a query executed under workspace A's session context cannot
  read or write workspace B's rows, including via a deliberately malformed/injection-shaped query.
- The `SpecRepository` interface's filesystem-backed (`packages/cli`) and Postgres-backed
  (`packages/server`) implementations both pass the same round-trip property test suite V1 already
  established (SLICES.md V1) — proving the new abstraction didn't regress local-mode behavior.
- A stored BYOK key round-trips through encryption/decryption correctly, and a tampered ciphertext
  (GCM auth tag mismatch) is rejected rather than silently decrypted into garbage.
- LiteLLM gateway failover correctly reroutes on a simulated provider outage without failing the
  user's run.

#### Unit

- Per-workspace BYOK key storage is encrypted at rest (verified by inspecting the raw
  `byok_keys.ciphertext` value in the database, not just via the application API) and inaccessible
  cross-workspace at the repository layer.
- RLS session-variable-setting middleware correctly scopes every request to exactly one
  `workspace_id`, with no code path that can omit it.
- Auth middleware correctly rejects an unauthenticated request and correctly resolves the current
  user + active workspace for an authenticated one.

## V6: Enterprise Governance

**Delivers:** R8

**Scoped by:** ADR-0017 (enterprise governance model). Requires V5 (hosted mode) as a hard
prerequisite — every V6 mechanism below is additive to V5's Postgres/RLS (ADR-0014) and Better Auth
(ADR-0015) foundations, not new infrastructure of its own.

**Build plan**

1. Activate Better Auth's `sso` plugin (adopted-but-dormant since V5, ADR-0015): per-workspace OIDC/
   SAML configuration, so a workspace admin can point their workspace at their own identity
   provider (Okta, Azure AD, Google Workspace, etc.) as its sign-in source. SCIM (automated user
   provisioning from the customer's IdP) is a separate, explicitly unscoped research spike — budget
   dedicated time for it rather than assuming the SSO plugin covers it (ADR-0017 §1).
2. Define the four RBAC roles (Creator/Operator/Auditor/Tool Manager) as a fixed permission matrix
   over `packages/server`'s existing routes, built on Better Auth's `organization` access-control
   primitive; add the auth-middleware enforcement (a denied route returns a clear 403, not a
   generic error) (ADR-0017 §2).
3. Build PII scrubbing/egress policy middleware around `packages/engine`'s HTTP tool-call path
   (`http-tool.ts`): workspace-configurable rules (blocked verbs, destination-domain allowlist,
   PII-pattern redaction), evaluated before dispatch, with a violation reusing the existing
   `requires_approval`/`fallback_action` pause mechanism from ADR-0009 rather than a new blocking
   protocol (ADR-0017 §3).
4. Add the `audit_events` table (ADR-0014's shared-schema-plus-RLS pattern) and write entries at
   the RBAC-middleware and PII/egress-gate enforcement points already built in steps 2–3; add a
   structured-JSON export endpoint for SIEM ingestion (ADR-0017 §4).
5. Add per-run cost/token estimation (from Vercel AI SDK response usage metadata) recorded on the
   `runs` table, with a configurable per-workspace threshold that halts further runs once crossed,
   surfaced via the existing fail-visibly convention (ADR-0004) rather than a silent throttle
   (ADR-0017 §5).

**Demo:** An admin configures SSO via an identity provider, invites a user with the Compliance
Auditor role (read-only), and that user can view an audit log entry for a real run but cannot edit
or run agents; a workspace configured with an egress policy blocking non-allowlisted domains has a
tool call attempting one of those domains pause for approval instead of executing; a workspace that
crosses its configured per-run cost threshold has its run halted with a clear, visible error.

**Rests on assumptions:** Requires V5 as a prerequisite (Postgres/RLS for `audit_events` and
per-workspace policy config; Better Auth for the `sso` plugin and `organization`-based RBAC) — none
of this is meaningful in a single-user local tool, and none of it is deployable before V5 exists.
SCIM is a known, explicitly flagged gap this slice's own build plan does not claim to close.

### Test plan

#### End-to-end

- A Compliance Auditor-role user can view audit logs and cannot create, edit, or execute agents.
- An SSO-configured workspace's user can log in via the customer's identity provider without a
  separate local password.
- A tool call attempting a non-allowlisted destination is paused for approval rather than executed,
  and the pause is visible in the run trace exactly like any other guardrail pause.

#### Integration

- Egress policy rules block a disallowed tool action (e.g., a request to a domain outside the
  allowlist) before it executes, reusing the existing approval-pause event stream rather than a
  parallel mechanism.
- A run exceeding its configured cost/token limit halts and is recorded as such in the `runs` table.
- RBAC middleware correctly denies every mutating route for the Auditor role while allowing
  read-only routes, for all four defined roles' full permission matrices.

#### Unit

- Audit log entries are structurally valid against the documented, versioned JSON schema.
- Cost-limit comparison logic correctly halts at the configured threshold, at and around the
  boundary value.
- PII-pattern redaction rules correctly match and redact configured patterns without over-matching
  unrelated content.

## V7: Multi-Agent Org-Chart Orchestration

**Delivers:** R9.1

Further out than V5/V6, not sequenced in detail yet — real design work (delegation semantics,
the org-chart canvas metaphor, a `sub_agents` spec extension) waits until the single-agent
duality/execution/export loop (V1–V4) is proven in practice (ADR-0001). Tracked on the roadmap
so it isn't lost, not planned to the same depth as the earlier slices.

**Sketch:** a manager agent delegates to worker agents (Researcher, Writer, Fact Checker, etc.);
users wire the org chart by drawing reporting/reassignment arrows, per the original ideation
(`ideation.md` §3.3.C). Design questions to resolve when this is actually scoped: how a
delegated call is represented in the single-agent execution engine, whether sub-agents are
separate spec files or nested in one, and what "duality" means for an org chart.

## V8: Natural-Language Prompt-to-Workflow Generator

**Delivers:** R9.2

Further out than V5/V6, not sequenced in detail yet — a separate, nondeterministic R&D problem
(Q13) that needs a stable spec/execution target to generate reliably against, which V1–V4
provide. Tracked on the roadmap so it isn't lost, not planned to the same depth as the earlier
slices.

**Sketch:** a user types "build me an agent that monitors my inbox for refund requests, checks
Stripe, and drafts a response" and the tool generates an initial `AgentSpec` (`ideation.md`
§3.2). Design questions to resolve when this is actually scoped: how generation quality gets
evaluated, what the fallback is when generation produces an invalid or nonsensical spec, and
whether this runs against BYOK models only or needs a dedicated fine-tuned/prompted approach.
