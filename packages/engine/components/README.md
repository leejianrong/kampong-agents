# First-party components

Components that ship with kampong (ADR-0025, ADR-0030). They live in the engine package so they travel
with the code that runs them. The `kampong/*` namespace is reserved for this folder: a project's own
`components/` folder cannot claim it, and the registry answers `kampong/*` from here alone.

Layout, one directory per version:

```
<namespace>/<name>/<version>/component.yaml    # the manifest
<namespace>/<name>/<version>/index.mjs         # kind: module only; compiled JavaScript
```

The path must match the manifest's `id` and `version`; a manifest anywhere else is reported and not
loaded. A component is identified by `id@version` and a content digest over every file in its
directory. A project can pin one in `kampong.lock` (`kampong lock <spec>`), but first-party components
do not need a pin to run.

Every component here is Apache-2.0 (`license: Apache-2.0` in the manifest), like the rest of the
repository; `test/unit/first-party-components.test.ts` checks the layout and the licence.

- `kampong/slack`: post a message (`kind: rest`).
- `kampong/gmail`: send a plain-text email (`kind: module`, because the API wants base64url MIME).
- `kampong/github`: read a pull request, its diff (cut at a file boundary past a size limit, and says so)
  and every changed file (follows pages, and says so when it stops); comment on or review a pull request
  (`kind: module`, because a request template cannot follow pages or cut a diff). A personal access token
  in `GITHUB_TOKEN`, sent only to `api.github.com`.
- `kampong/supabase`: insert, upsert (`on_conflict`), select (with filters) and call a function (`rpc`) on a
  project's PostgREST API, with PostgREST error bodies reported in full (`kind: module`, because a template
  cannot send an array body, build a filter query string or read an error body; ADR-0044). The project URL
  in `SUPABASE_URL` and the key in `SUPABASE_KEY`, sent only to `*.supabase.co`.
- `kampong/alpha-vantage`: daily prices (`kind: rest`). Alpha Vantage reports a rate limit, a bad symbol
  and a bad key as HTTP 200, so `failure_when` turns each into a failure; requests are paced at one per
  second. The key in `ALPHAVANTAGE_API_KEY`, sent only to `www.alphavantage.co`.
