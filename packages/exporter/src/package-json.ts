import type { AgentSpec } from "@kampong/spec";

// Generated package.json for an exported project (PLAN.md Shape S6,
// SLICES.md V4 KAN-1114/1116, ADR-0002, docs/adr/0010). Declares only real,
// resolvable dependencies -- KAN-1116's automated check is what proves this
// stays true: no `@kampong/*` package and no `file:`/`link:` reference back
// to this repo.
//
// Versions below mirror packages/engine/package.json's real dependency set
// (the vendored runtime files in templates/runtime/ are copies of that
// package's source -- see ADR-0010) and packages/cli/package.json's fastify
// dependency (the webhook server, KAN-1435). They are NOT read from those
// files at export time -- exporter has no runtime dependency on either
// package, only a manually-kept-in-sync copy, itself an instance of
// ADR-0010's accepted "two places" tradeoff.
//
// EXACT versions (no `^`/`~` range), pinned to what this repo's own root
// package-lock.json actually resolves -- i.e. the specific version
// combination this repo's own build/typecheck/test suite has verified
// mutually compatible. KAN-1435 found this the hard way: with caret ranges
// here, a fresh `npm install` in a *standalone* exported project (no
// lockfile of its own) resolved newer `@mastra/core`/`ai`/`@ai-sdk/*` patch
// versions than this repo's lockfile pins, and that newer combination broke
// `tsc` (a `MastraModelConfig`/`LanguageModelV4` type mismatch) -- invisible
// via `npm start` (tsx transpiles without type-checking) but fatal to `npm
// run build`, which the exported project's own Dockerfile (KAN-1435) now
// depends on. Exact pins make a fresh export's dependency resolution
// deterministic instead of "whatever satisfies the range today".
//
// Exported (rather than kept module-private) specifically so
// test/integration/dependency-version-sync.test.ts -- finding #4's
// automated check -- can assert every pin here still matches what the root
// lockfile actually resolves, so a version bump there (e.g. a security fix)
// can't silently go stale here.
export const ENGINE_DEPENDENCY_VERSIONS = {
  "@ai-sdk/anthropic": "4.0.49",
  "@ai-sdk/openai": "4.0.57",
  "@mastra/core": "1.64.0",
  ai: "7.0.91",
  zod: "4.5.4",
} as const;

export const SERVER_DEPENDENCY_VERSIONS = {
  fastify: "5.12.1",
} as const;

const DEV_DEPENDENCY_VERSIONS = {
  "@types/node": "^22.10.5",
  tsx: "^4.19.2",
  typescript: "^5.7.2",
} as const;

/**
 * A valid, reasonably readable npm package name derived from the spec's
 * `agent.id` -- lowercased, non-alphanumerics collapsed to a single hyphen,
 * leading/trailing hyphens trimmed. Falls back to a generic name if that
 * leaves nothing usable (e.g. an id that's entirely punctuation).
 */
export function slugifyPackageName(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "kampong-exported-agent";
}

export function buildPackageJson(spec: AgentSpec): Record<string, unknown> {
  return {
    name: slugifyPackageName(spec.agent.id),
    version: "0.1.0",
    private: true,
    type: "module",
    description: `Standalone Mastra agent exported from a Kampong Agents spec ("${spec.agent.name}"). One-way export -- see README.md.`,
    scripts: {
      start: "tsx src/index.ts",
      serve: "tsx src/server.ts",
      build: "tsc -p tsconfig.json",
      typecheck: "tsc --noEmit -p tsconfig.json",
    },
    dependencies: { ...ENGINE_DEPENDENCY_VERSIONS, ...SERVER_DEPENDENCY_VERSIONS },
    devDependencies: { ...DEV_DEPENDENCY_VERSIONS },
  };
}
