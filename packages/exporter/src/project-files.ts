import type { AgentSpec } from "@kampong/spec";

// The small set of plain project files every export needs besides
// package.json and the entry point/runtime (PLAN.md Shape S6, SLICES.md V4
// KAN-1114). Kept deliberately minimal -- this is meant to be a small,
// clean starting point the developer now owns (ADR-0002), not a scaffold
// with more moving parts than the spec actually needed.

export function buildTsconfig(): Record<string, unknown> {
  return {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      outDir: "dist",
      rootDir: "src",
    },
    include: ["src"],
  };
}

export function buildGitignore(): string {
  return ["node_modules/", "dist/", "*.tsbuildinfo", ".env", ".env.*", "!.env.example", ""].join(
    "\n",
  );
}

const ENV_VAR_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Every env var this spec's configuration needs at runtime: `agent.model.api_key`,
 * any connector tool's `${ENV}` token (`slack_post_message`/`gmail_send`, KAN-1430),
 * `agent.approval_notifier.token` (KAN-1432), plus `SLACK_SIGNING_SECRET` -- a
 * fixed, well-known name rather than a spec-level `${ENV}` placeholder, since
 * a deployed process has one Slack app (and so one signing secret) regardless
 * of which spec it's serving, but it's just as required for `approval_notifier`
 * to actually work, so it belongs in the same "set these before you run it" list.
 */
export function collectRequiredEnvVars(spec: AgentSpec): string[] {
  const vars = new Set<string>();
  const add = (placeholder: string | undefined): void => {
    const match = placeholder ? ENV_VAR_PATTERN.exec(placeholder) : null;
    if (match) vars.add(match[1]!);
  };
  add(spec.agent.model?.api_key);
  for (const tool of spec.agent.tools ?? []) {
    if (tool.action === "slack_post_message" || tool.action === "gmail_send") {
      add(tool.token);
    }
  }
  add(spec.agent.approval_notifier?.token);
  if (spec.agent.approval_notifier?.type === "slack") vars.add("SLACK_SIGNING_SECRET");
  return [...vars];
}

export function buildEnvExample(spec: AgentSpec): string | undefined {
  const vars = collectRequiredEnvVars(spec);
  if (vars.length === 0) return undefined;
  return [
    "# Copy to .env (gitignored) and fill in real values.",
    "# This agent reads these at process start -- never commit real values here.",
    "",
    ...vars.map((v) => `${v}=`),
    "",
  ].join("\n");
}
