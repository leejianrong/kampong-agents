# ADR-0044: Supabase as a module component, Alpha Vantage as a manifest

Date: 2026-10-12. Status: accepted. Builds on ADR-0029 (manifests), ADR-0031 (module permissions) and ADR-0035 (module retry).

## Context

KAN-1861 adds two first-party components. The card described Supabase as a pure-HTTP manifest and Alpha
Vantage as a preset over `http_request` v2. Writing the Supabase manifest showed that the `rest` interpreter
cannot express four things PostgREST needs:

- a request body that is a JSON array (insert and upsert send `[{...}, {...}]`; a `body.json` template is an
  object or an array of templates, never one input value);
- a query string whose parameter names come from the input (a filter is `status=eq.open`, the column is the
  name), where `query` has fixed names;
- reading the body of a non-2xx answer (PostgREST puts `code`, `message`, `details` and `hint` there; the
  interpreter reports the status line only);
- a project URL taken from a secret slot (the interpreter's configurable host comes from `config`, which a
  `kind: module` cannot read).

## Decision

- **`kampong/supabase` is a `kind: module`**, still pure HTTP: it only calls `ctx.fetch`. Extending the
  interpreter for one connector would put PostgREST-shaped features (array roots, dynamic query names, error
  bodies) into a contract every manifest shares. GitHub (KAN-1872) made the same call for the same reason.
- **Two slots, as the card asks:** `url` (`SUPABASE_URL`, the project URL) and `key` (`SUPABASE_KEY`), both
  bound to `*.supabase.co`. The module accepts only `https://<ref>.supabase.co` with no port, so a wrong value
  cannot send the key to another host even inside the wildcard. The wildcard is wider than one project; that
  is the price of reading the URL from a slot, and the module's own check closes it. The key is sent as the
  `apikey` header only: the newer publishable and secret keys are not JWTs, so a Bearer header would be refused.
- **Preferences:** `return=minimal` by default (`returning: representation` to get rows), and upsert adds
  `resolution=merge-duplicates` (or `ignore-duplicates`) with `on_conflict` in the query string.
- **Error mapping:** the body's code, message, details and hint are reported with the status, plus a short
  piece of advice for the codes people meet most (unique violation, row-level security, missing table or
  function). Retry follows ADR-0035: a 429 for any op, 408 and 5xx for reads only, `Retry-After` honoured.
  A write is never repeated after a 5xx, since it may have been applied.
- **The probe is `GET /auth/v1/settings`,** not a PostgREST route: it answers 401 for a bad key whatever the
  key's role and whatever the tables' policies are, whereas the REST root is refused to non-service keys.
- **`kampong/alpha-vantage` stays a `kind: rest` manifest** (the thin preset the card describes): `failure_when`
  rules turn the 200-OK bodies (`Information`, `Note`, `Error Message`, and any body without
  `Time Series (Daily)`) into failures, with `pace: { rps: 1 }` and a retry policy. Only the burst-limit
  `Information` is marked retryable; a spent daily quota, a bad symbol or a bad key will not be fixed by trying
  again, and each retry would spend more of a small quota. Its probe is a real daily-prices call for `IBM`
  (Alpha Vantage has no free account endpoint), and only `apikey is invalid` / `invalid or missing` count as a
  refused key.

## Consequences

- The canvas gets a full form for Alpha Vantage. For the Supabase table ops, the free-form `rows`, `filter`
  and `args` properties have no field kind, so those ops use the existing YAML `with` editor (the documented
  fallback); `check_key` needs no input. Teaching the form planner free-form objects is a separate change.
- Alpha Vantage's response keys contain spaces, which an output schema cannot name, so its output is an
  untyped object.
- A change to either component changes its digest: run `npm run generate:registry-index` in `packages/engine`.
