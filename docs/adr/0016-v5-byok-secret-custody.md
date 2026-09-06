# ADR-0016: V5 BYOK secret custody

- Status: Accepted
- Date: 2026-09-06
- Deciders: Jian (product owner)

## Context

BYOK key resolution today (`packages/engine/src/model.ts:255-270, 393-454`) is a `${ENV_VAR}`
placeholder resolved against `process.env` — literally the developer's own shell environment on
their own laptop, where "security" is simply that nobody else has access to that machine. V5's
workspace-scoped BYOK key storage (KAN-1119) is a fundamentally different trust model: storing
_another person's_ real API key at rest, on infrastructure the tool operator controls but the key's
owner does not, with no cloud KMS available to lean on (the homelab deployment target, per
ADR-0013, has no AWS/GCP account backing it).

## Decision

**Application-level envelope encryption**, using Node's built-in `node:crypto` (AES-256-GCM) — no
new heavy dependency, consistent with this project's pattern of picking a specific tool for a
specific concrete property rather than reaching for a framework by default (ADR-0007's `yaml`
choice; ADR-0015's reasoning for Better Auth).

- A single **root encryption key** (32 random bytes, generated once at first deploy) is stored as a
  Kubernetes `Secret` (ADR-0013) — never in Postgres, never in a repo, never logged.
- Each BYOK API key value is encrypted with AES-256-GCM directly under the root key before being
  written to `byok_keys.ciphertext` (ADR-0014); GCM's authentication tag makes tampering with a
  stored ciphertext detectable, not just confidentiality-protected — this matters because a
  corrupted-but-undetected key would otherwise surface as a confusing downstream provider-auth
  failure rather than an obvious integrity error.
- The root key is loaded once at `packages/server` startup from the mounted `Secret`/environment
  variable and held only in memory for the process's lifetime.
- Decryption happens **only** inside the same code path that resolves a model call today
  (`model.ts`'s `resolveEnvVarPlaceholder`/`createMastraModelClient`, per the existing DI seam where
  `env` is an injectable `NodeJS.ProcessEnv`-shaped parameter rather than hardcoded to
  `process.env`) — at the exact moment a run needs to actually call a provider. A decrypted key is
  never cached, never logged, and never returned in any API response; the browser/canvas never sees
  a workspace's real key value, only whatever masked/redacted representation the UI needs to show
  that a key is configured (e.g. `sk-...ab12`).

**Key rotation is explicitly out of scope for a first cut**, flagged as an open question rather than
solved here — rotating the root key requires re-encrypting every stored value, a real migration
with no existing customer data to protect yet, so there is no cost to deferring it until it's
actually needed.

## Alternatives considered

| Option                                                      | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HashiCorp Vault (self-hosted)                               | A whole additional stateful service with its own unseal/auto-unseal operational burden — disproportionate infrastructure for what a single well-implemented envelope-encryption scheme handles adequately at this scale. Revisit if a future security audit or V6 governance work specifically demands it; building it preemptively repeats the "governance infra before a customer justifies it" mistake ADR-0004 already named for the LLM gateway. |
| Cloud KMS (AWS/GCP)                                         | Unavailable — no cloud account backs a homelab deployment.                                                                                                                                                                                                                                                                                                                                                                                            |
| Plaintext storage, relying on Postgres access control alone | Unacceptable for a real multi-tenant SaaS holding other people's live API credentials — a single misconfigured access grant or a database backup falling into the wrong hands would leak every stored key directly.                                                                                                                                                                                                                                   |
| Per-workspace root keys instead of one global root key      | Stronger cryptographic tenant isolation (a compromised root key for one workspace wouldn't affect others), but no identified requirement drives that need yet, and it substantially complicates key-management/backup for no currently-justified benefit — a global root key is proposed as the V5 starting point, with per-workspace keys as a documented future option.                                                                             |

## Consequences

- A Postgres backup (via ADR-0013's CNPG-managed backups) alone cannot leak BYOK keys, since the
  `byok_keys.ciphertext` column is meaningless without the root key — but the root Kubernetes
  `Secret` itself becomes the single most sensitive artifact in the whole deployment. Losing it,
  without a separate backup of the key itself, permanently and irrecoverably breaks every stored
  BYOK key across every workspace. This must be an explicit line item in the homelab backup/DR
  runbook (ADR-0013), not an implicit assumption that "the database is backed up" is sufficient.
- The `model.ts` DI seam (the injectable `env` parameter) that made this integration point possible
  was not originally built with hosted mode in mind — a happy accident of the test-injection
  pattern, per the codebase research behind this ADR — and V5 implementation should make that seam
  intentional and documented, not just continue relying on it implicitly.

## Open questions for V5 implementation to revisit

- Root key backup/DR procedure, concretely (where the backup lives, who/what can restore it).
- Whether a global root key remains acceptable once real customers exist, or whether demand
  emerges for workspace-level cryptographic isolation.
- Key rotation strategy and tooling, once rotation is actually needed.
