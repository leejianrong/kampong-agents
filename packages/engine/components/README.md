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
