import type { AgentSpec } from "@kampong/spec";
import { collectRequiredEnvVars } from "./project-files.js";

// The exported project's README (SLICES.md V4 KAN-1114): documents the
// one-way-export contract (ADR-0002) up front -- "hand-editing this and
// expecting it to sync back to canvas is explicitly unsupported" is a
// PLAN.md-called-out requirement, not just a nice-to-have -- plus what env
// vars a real run needs and how to run it.

export function buildReadme(spec: AgentSpec): string {
  const envVars = collectRequiredEnvVars(spec);
  const slackApprovalSection =
    spec.agent.approval_notifier?.type === "slack"
      ? [
          "## Headless approval via Slack",
          "",
          "This spec's `approval_notifier` posts an interactive Approve/Reject message to Slack " +
            "whenever a run pauses -- there's no canvas attached to `src/server.ts` to watch it " +
            "happen instead. To wire this up against a real Slack app:",
          "",
          "1. Create a Slack app with a bot token that can post to the configured channel " +
            "(`chat:write` scope) -- that's `SLACK_BOT_TOKEN` below.",
          "2. Turn on **Interactivity & Shortcuts** in the app's settings and set the Request URL " +
            "to `https://<this-service>/slack/interactions` (needs a public URL -- `ngrok`/a " +
            "tunnel for local testing, the real deployed URL otherwise).",
          "3. Copy the app's **Signing Secret** into `SLACK_SIGNING_SECRET` -- every `/slack/" +
            "interactions` request is HMAC-verified against it before a click is trusted to " +
            "resolve a run; a missing or wrong secret fails closed (401), it never silently trusts " +
            "an unverified request.",
          "",
        ]
      : [];
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
    "- `src/index.ts` -- the run-once entry point: this spec's role/goal/tools/workflow/",
    "  guardrails/model config, wired against the runtime below.",
    "- `src/server.ts` -- the live webhook server (`npm run serve`): the same spec, triggerable",
    "  over HTTP instead of run once from the command line.",
    "- `src/runtime/` -- the execution engine (condition evaluation, the guardrail check, the",
    "  HTTP tool wrapper, the workflow step-sequencer, model-provider resolution for",
    "  anthropic/openai/ollama/openrouter, and the run cache `src/server.ts` uses). This is real,",
    "  tested logic copied in at export time, not generated from a template -- see",
    "  `docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md` in the originating repo if",
    "  you want the full reasoning. It's yours now; edit it freely.",
    "- `Dockerfile` / `.dockerignore` -- builds a container image that runs `src/server.ts`.",
    "",
    "## Running it once",
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
    "## Running it as a live webhook service",
    "",
    "`src/server.ts` is the deployable counterpart: it stays up and starts one run per incoming",
    "webhook event, mirroring `kampong serve` (see the originating repo's",
    "`docs/adr/0021-real-world-workflows-direction.md` and",
    "`docs/adr/0022-deployment-model-two-paths.md`).",
    "",
    "```",
    "npm install",
    "npm run serve   # listens on $PORT (default 8080) / $HOST (default 0.0.0.0)",
    "```",
    "",
    "| Endpoint | Description |",
    "| --- | --- |",
    "| `POST /webhook` | Starts a run; the request body is the run's input. Returns `{ id, state }`. |",
    "| `GET /runs/:id` | The run's current state. |",
    "| `GET /runs/:id/events` | Server-Sent Events stream of the run's progress. |",
    "| `POST /runs/:id/approve` | Resolves a paused run: `{ approved: boolean, reason? }`. |",
    '| `POST /slack/interactions` | Slack\'s interactivity callback -- see "Headless approval via Slack" below. |',
    "| `GET /healthz` | Liveness check. |",
    "",
    "Execution is on-demand: each webhook event drives one run on this process, there is no",
    "always-on per-workflow worker.",
    "",
    ...slackApprovalSection,
    "## Deploying as a container",
    "",
    "```",
    "docker build -t my-agent .",
    "docker run -p 8080:8080 -e ANTHROPIC_API_KEY=... -e SLACK_BOT_TOKEN=... my-agent",
    "```",
    "",
    "The image runs `npm run serve`'s compiled equivalent (`node dist/server.js`) by default. Every",
    "connector/model credential the spec references is supplied as a `docker run -e` environment",
    "variable -- never baked into the image (same `${ENV}` secrets model as running it locally).",
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
