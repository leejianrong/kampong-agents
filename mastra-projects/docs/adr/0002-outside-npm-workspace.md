# ADR-0002: The demos live outside the npm workspace

- Status: Accepted
- Date: 2026-09-20
- Deciders: leejianrong

## Context

Root `AGENTS.md` requires `npm run build` to stay a dependency-graph-aware
`tsc -b` at the repo root, and the pre-push hook runs
lint + format:check + build + typecheck + test:unit across the whole
workspace as the fast, no-infra gate every push goes through. The 5 Mastra
demos are throwaway/reference code that exists to answer a research question,
not code the product ships — folding them into that graph would slow every
contributor's (and every agent's) fast gate for code nobody is shipping.

## Decision

Each demo under `mastra-projects/<demo>/` gets its own `package.json` and
lockfile, is installed and run independently (`npm install && npm run dev`
inside that folder), and is excluded from the root TypeScript project
references, the root ESLint scope, and the pre-push hook / root `npm test`.
`mastra-projects/README.md` states this explicitly so it isn't rediscovered
the hard way.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Add each demo as a workspace package | Couples unrelated throwaway code to the product's build graph; slows CI and local `tsc -b`/lint/test for code that isn't part of kampong-agents |
| A separate sibling repo | The user explicitly asked for a subfolder in this repo, and keeping the demos next to the product roadmap they're meant to inform is more useful than splitting them out |

## Consequences

Each demo can pick whatever dependency versions and tooling suit its own use
case (e.g. a different Mastra version, a different test runner) without
coordinating with the product's toolchain. The cost is that each demo needs
its own minimal setup rather than inheriting the monorepo's, and anyone
running `npm run build`/`npm test` at the repo root should not expect it to
touch `mastra-projects/` at all.
