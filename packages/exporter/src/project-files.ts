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

/** Every distinct `${ENV_VAR}` name the spec references (today: only `agent.model.api_key`). */
export function collectRequiredEnvVars(spec: AgentSpec): string[] {
  const vars = new Set<string>();
  const apiKey = spec.agent.model?.api_key;
  const match = apiKey ? ENV_VAR_PATTERN.exec(apiKey) : null;
  if (match) vars.add(match[1]!);
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
