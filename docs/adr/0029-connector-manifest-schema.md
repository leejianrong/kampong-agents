# ADR-0029: The connector manifest schema and how a spec uses a component

- Status: Accepted
- Date: 2026-10-06
- Deciders: Jian (product owner)

## Context

ADR-0025 decided that components are hybrid: declarative manifests interpreted by the engine, plus
reviewed TypeScript modules, under one operation contract. This ADR fixes the shape of that contract
before the connector framework (KAN-1832 and its parts) is built, because every later component
builds on it.

Today a connector operation touches five places: the `toolSchema` union in `packages/spec`, the
`buildToolFromForm` builder, the canvas `ToolForm`, the engine's `buildToolRequest` switch
(`http-tool.ts`, which hard-codes the Slack and Gmail request shapes), and the exporter's vendored
runtime copy (ADR-0010). A manifest expresses that translation as data so none of those need to
change per connector.

## Decision

1. **A spec references a component with a new tool variant `action: component`:**
   `{ name, action: component, use: <id>@<version>, op, with: {...}, secrets?: { <slot>: ${ENV} } }`.
   Workflow `type: tool` steps are unchanged. The legacy kinds `http_request`, `slack_post_message`
   and `gmail_send` stay valid indefinitely and are desugared to component calls when a spec loads;
   the published JSON Schema keeps validating them.
2. **Two manifest kinds share one operation contract:** `kind: rest` (declarative) and
   `kind: module` (TypeScript entry exporting `invoke(op, input, ctx)`, run behind the `Runner`
   interface of ADR-0026). A module sees only a `ComponentContext` (`secrets.get(slot)`, an
   egress-checked `fetch`, an `AbortSignal`), never `process.env`.
3. **An operation declares:** `title`, `effect: read | write | destructive`, an `input` JSON Schema
   subset (drives validation and canvas forms), a `request` description (`method`, `url`, `headers`,
   `query`, `body`), a `response` mode (`json | text | bytes`), `failure_when` rules, an optional
   `output` schema, `pace`, `retry` and `fixture_key`. `effect: destructive` requires approval unless
   the spec overrides it.
4. **One shared `RequestSpec` type** describes the request/response/failure/pacing/retry fields. It is
   built first as the `http_request` v2 work (KAN-1845, KAN-1846); a manifest op embeds it, and
   `http_request` becomes an anonymous inline op. It is not implemented twice.
5. **Auth is separate from operations:** `auth.slots.<name>` has a default `env`, `hosts` it may be
   sent to, and an `inject` rule (`header` or `query` plus a `template` over `{{ secret }}`). The
   engine injects after templating, so a secret never appears in input, fixtures or logs. A spec may
   remap a slot's env var with `secrets`.
6. **Templating is plain `{{ path }}` interpolation only** in manifests. It is independent of the
   expression-language spike (ADR-0027) and can be extended later without breaking manifests.
7. **Paths** (`extract`, `failure_when`) use a minimal syntax: dotted keys, `["quoted keys"]` and
   numeric indexes. No full JSONPath.
8. **Hosts that depend on configuration:** an op may take non-secret `config` params, and `egress`
   and `url` may reference them (`{{ config.project }}.supabase.co`). The permission check runs on the
   resolved host. Non-HTTP transports use `host:port` entries, enforced through the module `ctx`.
9. **Versions:** a spec names an exact `id@version`; the digest is recorded in `kampong.lock`
   (ADR-0025). No ranges.
10. **One error shape:** `{ code, op, message, retryable, status? }` with codes `input`,
    `permission`, `auth`, `rate_limit`, `failure_when`, `http`, `timeout`. Retries apply only to
    `retryable` errors; failures always surface visibly.
11. **Record and replay moves to the operation boundary** (KAN-1833): key is component digest, op and
    a canonical hash of the redacted input.

## Consequences

- KAN-1832 is split into four pull requests: A schema and interpreter, B registry and loader (KAN-1884),
  C canvas forms (KAN-1885), D migration and exporter vendoring (KAN-1886). `http_request` v2
  (KAN-1845, KAN-1846) lands first.
- Moving fixtures above `fetch` means fixtures recorded at the fetch level need re-recording; none are
  committed in this repository.
- Permission and slot fields are in the schema from the first release so enforcement (KAN-1835) lands
  without a breaking change.
- Not covered here: trigger manifests, workflow steps, an MCP `source`, registry signing.
