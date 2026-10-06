# ADR-0026: Component trust tiers, vetting, and MCP as an import layer

- Status: Accepted
- Date: 2026-10-06
- Deciders: Jian (product owner)

## Context

ADR-0025 creates a component repository. The dev team is its only author now, but a contributed
marketplace is an intended later step, so the trust model must not preclude it. A review of supply
chain incidents in comparable ecosystems (npm event-stream and the Shai-Hulud worm, tj-actions,
n8n community nodes, postmark-mcp, MCP tool-poisoning and rug-pull attacks, OpenClaw/ClawHub, VS
Code extensions, Chrome Web Store) found one pattern: **account and token takeover, and malicious
updates, defeat code review**, and mutable references defeat approval.

The closest analogue is n8n community nodes, which run unsandboxed with decrypted credentials; eight
malicious ones stole OAuth credentials in January 2026. postmark-mcp shipped fifteen clean versions
and then one that BCC'd all mail to the attacker through the legitimate API, so an egress allow-list
alone would not have stopped it.

Kampong is exposed on three surfaces: the canvas and local engine, the hosted multi-tenant server
that runs components with a tenant's secrets (ADR-0024), and exported projects that bundle a
component and cannot be revoked remotely.

Evidence caveat: the incident details and sandbox comparisons came from search summaries, not full
page fetches. The tier model, egress-injected secrets and release cooldown are our own design.

## Decision

### 1. Three trust tiers

| Tier | Who | May contain | Controls |
| ---- | --- | ----------- | -------- |
| 0 first-party | dev team | manifests and in-repo TypeScript | two-person review, keyless Sigstore signing |
| 1 verified | publisher-verified | manifests; TypeScript only in a permission-scoped sandbox | our countersignature on the reviewed digest, human review when permissions or code change, release cooldown |
| 2 community | anyone | **declarative manifests only, no custom code** | consent screen on install, no auto-update, labelled unreviewed |

Only tier 0 ships at first. A workflow template is capped at the lowest tier among its components.

### 2. Do now, while first-party only (hard to retrofit)

- Permission manifest on every component, enforced on first-party components too: per-host egress
  allow-list, named secret slots bound to hosts, and declared filesystem, env and exec permissions.
  A permission-widening update forces re-approval.
- Secrets are injected at the egress layer by slot. A declarative component never sees plaintext;
  TypeScript modules never get ambient `process.env`.
- Components are addressed by `namespace/name@version` plus a content digest, locked in
  `kampong.lock`. No mutable tags. Tool descriptions and schemas are hashed at install; any change
  is a reviewed event (CVE-2025-54136 shows approval does not survive a later server-side change).
- No install scripts, no `eval`, no remote code fetch.
- Release signing with Sigstore, an SBOM, and digests shipped inside every export, so a user can
  verify what an exported project holds.
- `Runner` isolation interface for TypeScript modules, so the sandbox can be chosen later without
  changing component code.
- A revocation field in the registry index from day one, and reserved `kampong/*` namespace.
- Tool outputs are treated as untrusted input to the model (prompt injection).

### 3. Minimum vetting pipeline (required before tier 1 or 2 opens)

1. Manifest schema and permission linter.
2. Reproducible bundle with a digest.
3. Static checks: no install scripts, eval or remote code; AST-inferred capabilities must be a
   subset of the manifest; scan for invisible and bidirectional Unicode, leaked secrets and
   obfuscation; scan documentation and descriptions for embedded instructions.
4. Dependency checks: pinned, malware and OSV feeds, SBOM.
5. Recorded-mock conformance tests in a sandbox with a canary secret.
6. CI gate failing on any permission or description change without a code owner.
7. Sigstore signing and provenance written to the index.
8. Revocation honoured by the engine and the hosted server.

### 4. MCP is an import and adaptation layer, not the primary format

- The primary format is the native manifest (ADR-0025). `kampong import mcp` generates a manifest
  with `source: mcp` that wraps a pinned MCP tool. The exporter emits either a direct HTTP call or an
  `@mastra/mcp` client.
- Reasons: MCP has no trigger, webhook or poll concept; tool outputs are often free text, so typed
  outputs must be declared anyway; servers are black boxes that drift, so the server version and a
  tool-schema hash are pinned and a mismatch fails visibly; the specification is still moving (the
  2026-07-28 revision is stateless-first and was reported as both final and a release candidate, to
  be confirmed before building); and MCP says nothing about idempotency or retries.
- Imported write tools default to `requires_approval: true`, because MCP annotations are advisory.
- Self-host may use remote bearer-token servers. Hosted mode never runs arbitrary stdio servers in
  the shared process (remote code execution by design); it allows a curated, pinned list of remote
  HTTP servers with `allowedHosts`, per-request toolsets and vault tokens, and audit logging.
- The official MCP Registry is in preview and authenticates namespaces only. "Registry-listed" does
  not mean safe and is not a trust signal for us.

### 5. Deferred

Community publishing, ratings, payments, and hosted execution of custom code. A sandbox technology
(isolates, Deno permissions, gVisor, microVMs) is chosen only after a dedicated threat review.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Open, unvetted community registry | n8n and ClawHub show open registries are flooded within weeks. |
| TypeScript community components in-process | The n8n failure: untrusted code with decrypted credentials. |
| MCP as the primary format | Section 4. |
| Review-only trust, no sandbox or permissions | Incidents show review alone does not catch account takeover or later updates. |

## Consequences

- Permission manifests and slot-bound secrets are part of the manifest schema from the first
  release, which raises the cost of the first connectors slightly and avoids a breaking change later.
- Exported projects cannot be revoked remotely (threat T9); digests and an SBOM are the mitigation.
- The hosted connector-secret vault (ADR-0024) must support slot-to-host binding before any tier 1
  component runs there.
- A `security.txt` and a vulnerability disclosure path are added with the first public release.
