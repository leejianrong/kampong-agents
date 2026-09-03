import type { AgentSpec } from "@kampong/spec";

// Generated package.json for an exported project (PLAN.md Shape S6,
// SLICES.md V4 KAN-1114/1116, ADR-0002, docs/adr/0010). Declares only real,
// resolvable dependencies -- KAN-1116's automated check is what proves this
// stays true: no `@kampong/*` package and no `file:`/`link:` reference back
// to this repo.
//
// Versions below are pinned to match packages/engine/package.json's real
// dependency set at the time this slice was built (the vendored runtime
// files in templates/runtime/ are copies of that package's source -- see
// ADR-0010). They are NOT read from that file at export time: exporter has
// no runtime dependency on packages/engine (only a manually-kept-in-sync
// copy), which is itself an instance of ADR-0010's accepted "two places"
// tradeoff -- keep this in sync by hand if packages/engine/package.json's
// versions change.
const ENGINE_DEPENDENCY_VERSIONS = {
  "@ai-sdk/anthropic": "^4.0.49",
  "@ai-sdk/openai": "^4.0.57",
  "@mastra/core": "^1.64.0",
  ai: "^7.0.91",
  zod: "^3.25.76",
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
      build: "tsc -p tsconfig.json",
      typecheck: "tsc --noEmit -p tsconfig.json",
    },
    dependencies: { ...ENGINE_DEPENDENCY_VERSIONS },
    devDependencies: { ...DEV_DEPENDENCY_VERSIONS },
  };
}
