# First-party components

Components kampong ships (ADR-0025). The `kampong/*` namespace is reserved for this folder: a user's
own `components/` folder cannot claim it. Nothing is published here yet, and the CLI does not read
this folder yet: the first component (`kampong/slack`, KAN-1886) brings the packaging that makes
it resolvable from a project.

Layout, one directory per version:

```
components/<namespace>/<name>/<version>/component.yaml    # the manifest
components/<namespace>/<name>/<version>/index.mjs          # kind: module only; compiled JavaScript
```

The path must match the manifest's `id` and `version`; a manifest anywhere else is reported and not
loaded. A component is identified by `id@version` and a content digest over every file in its
directory, pinned in a project's `kampong.lock` (`kampong lock <spec>`). There are no tags or ranges.

Every component here is Apache-2.0 (`license: Apache-2.0` in the manifest), like the rest of the
repository. See `docs/adr/0025-component-model-and-repository.md` and
`docs/adr/0026-component-trust-tiers-and-mcp.md`.
