import type { AgentSpec } from "@kampong/spec";
import { collectRequiredEnvVars } from "./project-files.js";

// The exported project's README (SLICES.md V4 KAN-1114): documents the
// one-way-export contract (ADR-0002) up front -- "hand-editing this and
// expecting it to sync back to canvas is explicitly unsupported" is a
// PLAN.md-called-out requirement, not just a nice-to-have -- plus what env
// vars a real run needs and how to run it.

export function buildReadme(spec: AgentSpec): string {
  const envVars = collectRequiredEnvVars(spec);
  const envSection =
    envVars.length > 0
      ? [
          "## Environment",
          "",
          "This agent needs the following environment variable(s), resolved at process start --",
          "never written into any file in this project:",
          "",
          ...envVars.map((v) => `- \`${v}\``),
          "",
          "Copy `.env.example` to `.env` (already gitignored) and fill in real values, or export",
          "them in your shell.",
          "",
        ]
      : [];

  return [
    `# ${spec.agent.name}`,
    "",
    `Standalone Mastra agent exported from a Kampong Agents spec (\`${spec.agent.id}\`).`,
    "",
    "## One-way export -- read this first",
    "",
    "This project was generated once, by `kampong export`, and is now entirely yours to edit,",
    "extend, and maintain. It has **zero dependency on Kampong Agents** -- not on the tool, not",
    "on the originating spec file, not on a registry package -- only on Mastra and the other",
    "packages declared in `package.json`.",
    "",
    "Editing this code does **not** sync back to the spec or the canvas, and re-exporting the",
    "same spec later will not merge with changes made here -- it would generate a fresh project",
    "from scratch. This is a deliberate one-way boundary (see this repo's",
    "`docs/adr/0002-yaml-source-of-truth-oneway-export.md` and",
    "`docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md`), not a missing feature.",
    "",
    "## What's in here",
    "",
    "- `src/index.ts` -- the runnable entry point: this spec's role/goal/tools/workflow/",
    "  guardrails/model config, wired against the runtime below.",
    "- `src/runtime/` -- the execution engine (condition evaluation, the guardrail check, the",
    "  HTTP tool wrapper, the workflow step-sequencer, and model-provider resolution for",
    "  anthropic/openai/ollama). This is real, tested logic copied in at export time, not",
    "  generated from a template -- see `docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md`",
    "  in the originating repo if you want the full reasoning. It's yours now; edit it freely.",
    "",
    "## Running it",
    "",
    "```",
    "npm install",
    "npm start                          # runs with a default input",
    'npm start -- --input "some text"   # runs with a specific input',
    "npm start -- --approve-all         # auto-approves any human-approval pause (non-interactive)",
    "npm start -- --json                # prints one JSON result object instead of a human summary",
    "```",
    "",
    "A step that requires approval (a `requires_approval` tool, or a guardrail confidence",
    "breach) pauses the run and prompts on stdin for `y`/`N`, exactly like `kampong run` does --",
    "pass `--approve-all` for non-interactive/CI use instead.",
    "",
    ...envSection,
    "## Tool calls",
    "",
    "This project always makes live HTTP calls for its tools -- there is no mock/record layer",
    "here (that's dev-tooling specific to iterating on a spec inside Kampong Agents, not part of",
    "a standalone run).",
    "",
  ].join("\n");
}
