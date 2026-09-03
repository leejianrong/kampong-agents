import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { AgentSpec, ModelProvider } from "@kampong/spec";
import type { z } from "zod";

// Model resolution (PLAN.md Shape S3, ADR-0003, ADR-0004, SLICES.md V2
// KAN-1103/1106). Kept as a small name -> factory map, per AGENTS.md, so
// adding the Ollama adapter (V3, out of scope here) is a one-entry addition
// rather than a redesign of this file. Every provider resolves straight
// through its Vercel AI SDK package -- no gateway/proxy layer in v1
// (ADR-0004).

type ProviderFactory = (modelName: string, apiKey: string) => MastraModelConfig;

const PROVIDERS: Record<ModelProvider, ProviderFactory> = {
  anthropic: (name, apiKey) => createAnthropic({ apiKey })(name),
  openai: (name, apiKey) => createOpenAI({ apiKey })(name),
};

const ENV_VAR_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export class MissingApiKeyError extends Error {
  constructor(
    public readonly envVar: string,
    public readonly provider: string,
  ) {
    super(
      `Missing API key: environment variable "${envVar}" (required by model provider "${provider}") is not set. ` +
        `Set it in your shell or a local .env file before running this agent -- never in the spec file itself.`,
    );
    this.name = "MissingApiKeyError";
  }
}

export class UnknownModelProviderError extends Error {
  constructor(public readonly provider: string) {
    super(
      `Unknown model provider "${provider}". Supported providers: ${Object.keys(PROVIDERS).join(", ")}.`,
    );
    this.name = "UnknownModelProviderError";
  }
}

/**
 * Resolves a `${ENV_VAR}` placeholder from `env`. Never returns/logs a
 * value that isn't the resolved secret itself, and the error path never
 * echoes the (absent) value -- only the variable *name* -- so a missing key
 * can't leak a secret through an error message or log line (KAN-1106).
 */
export function resolveEnvVarPlaceholder(
  placeholder: string,
  provider: string,
  env: NodeJS.ProcessEnv,
): string {
  const match = ENV_VAR_PATTERN.exec(placeholder);
  if (!match) {
    throw new Error(`Model api_key must be a \${ENV_VAR} placeholder; got a value that isn't one.`);
  }
  const envVar = match[1]!;
  const value = env[envVar];
  if (!value) {
    throw new MissingApiKeyError(envVar, provider);
  }
  return value;
}

export interface GenerateTextInput {
  instructions: string;
  prompt: string;
}

export interface GenerateStructuredInput<T> {
  instructions: string;
  prompt: string;
  schema: z.ZodType<T>;
}

/**
 * The engine's model-call seam. In production this is backed by a real
 * `@mastra/core` Agent (see `createMastraModelClient`); tests inject a fake
 * implementation so guardrail/HITL/condition logic is fully exercisable
 * without a live network call (AGENTS.md's testing approach) while the
 * Mastra-backed path itself stays exactly what a real run uses.
 */
export interface ModelClient {
  generateText(input: GenerateTextInput): Promise<string>;
  generateStructured<T>(input: GenerateStructuredInput<T>): Promise<T>;
}

/**
 * Builds a real Mastra `Agent` from the spec's role/goal/model (KAN-1103)
 * and wraps it behind `ModelClient`. Throws synchronously -- before any
 * network call is made -- on a missing/invalid model config or a missing
 * BYOK env var, so a caller (the CLI server, eventually `kampong run`) can
 * surface a specific, immediate error rather than a run that fails deep
 * inside its first step.
 */
export function createMastraModelClient(
  spec: AgentSpec,
  env: NodeJS.ProcessEnv = process.env,
): ModelClient {
  const modelConfig = spec.agent.model;
  if (!modelConfig) {
    throw new Error(
      `Agent "${spec.agent.id}" has no \`agent.model\` configured; add a provider/name/api_key before running it.`,
    );
  }

  const factory = PROVIDERS[modelConfig.provider];
  if (!factory) {
    throw new UnknownModelProviderError(modelConfig.provider);
  }

  const apiKey = resolveEnvVarPlaceholder(modelConfig.api_key, modelConfig.provider, env);
  const model = factory(modelConfig.name, apiKey);

  const agent = new Agent({
    id: spec.agent.id,
    name: spec.agent.name,
    instructions: `Role: ${spec.agent.role}\nGoal: ${spec.agent.goal}`,
    model,
  });

  return {
    async generateText({ instructions, prompt }) {
      const result = await agent.generate(prompt, { instructions });
      return result.text;
    },
    async generateStructured<T>({ instructions, prompt, schema }: GenerateStructuredInput<T>) {
      const result = await agent.generate(prompt, { instructions, structuredOutput: { schema } });
      return result.object as T;
    },
  };
}
