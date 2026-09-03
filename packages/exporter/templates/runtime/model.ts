// Vendored from packages/engine/src/model.ts as part of a `kampong export`
// -- see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. The
// only change from the source file is the `AgentSpec`/`Model`/`ModelProvider`
// type import, which now comes from the local ./spec-types.js rather than
// "@kampong/spec" (this project has no dependency on that package --
// ADR-0002). From here on this file is yours: it will not be touched again
// by a future export.

import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { AgentSpec, Model, ModelProvider } from "./spec-types.js";
import type { z } from "zod";

// Model resolution: a small name -> factory map so adding a provider later
// is a one-entry addition rather than a redesign of this file. Every
// provider resolves straight through its Vercel AI SDK package -- no
// gateway/proxy layer.
//
// Ollama speaks an OpenAI-compatible `/v1` API, so rather than pull in a
// dedicated Ollama Vercel-AI-SDK provider package, this reuses
// `@ai-sdk/openai` -- already a dependency -- pointed at the local server
// with a throwaway api key (Ollama doesn't check it). This still goes
// straight through Mastra's AI SDK provider interface; nothing about it is
// a gateway/proxy layer.

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

// Which providers require a real BYOK `${ENV_VAR}` api_key -- "ollama" has
// no key to check.
const CLOUD_PROVIDERS: ReadonlySet<ModelProvider> = new Set(["anthropic", "openai"]);

interface ProviderFactoryOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

type ProviderFactory = (modelName: string, options: ProviderFactoryOptions) => MastraModelConfig;

const PROVIDERS: Record<ModelProvider, ProviderFactory> = {
  anthropic: (name, { apiKey, fetchImpl }) => createAnthropic({ apiKey, fetch: fetchImpl })(name),
  openai: (name, { apiKey, fetchImpl }) => createOpenAI({ apiKey, fetch: fetchImpl })(name),
  // `.chat(name)`, not the bare factory call: `createOpenAI(...)(name)`
  // defaults to OpenAI's newer Responses API (`POST /v1/responses`), which
  // Ollama's OpenAI-compatibility layer does not implement -- Ollama only
  // serves the classic Chat Completions API (`POST /v1/chat/completions`).
  ollama: (name, { baseUrl, fetchImpl }) =>
    createOpenAI({
      apiKey: "ollama",
      baseURL: `${baseUrl ?? DEFAULT_OLLAMA_BASE_URL}/v1`,
      fetch: fetchImpl,
    }).chat(name),
};

const ENV_VAR_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export class MissingApiKeyError extends Error {
  constructor(
    public readonly envVar: string,
    public readonly provider: string,
  ) {
    super(
      `Missing API key: environment variable "${envVar}" (required by model provider "${provider}") is not set. ` +
        `Set it in your shell or a local .env file before running this agent -- never in a source file.`,
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
 * The specific, actionable error thrown when the local Ollama server can't
 * be reached -- never a silent fallback to a paid cloud API. Unlike a
 * missing BYOK key, this can only be detected at call time -- there is no
 * key to check synchronously -- so it's raised from inside
 * generateText/generateStructured when the underlying fetch fails with a
 * connection-refused-shaped error (see isConnectionRefused below), and it is
 * never caught and retried against `anthropic`/`openai`.
 */
export class OllamaUnavailableError extends Error {
  constructor(
    public readonly baseUrl: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Could not reach the local Ollama server at ${baseUrl}. Start it with \`ollama serve\` ` +
        `(or check the spec's \`agent.model.base_url\` / that Ollama is listening on the expected ` +
        `host) before running this agent. This is never silently retried against a cloud provider.`,
      options,
    );
    this.name = "OllamaUnavailableError";
  }
}

/**
 * Resolves a `${ENV_VAR}` placeholder from `env`. Never returns/logs a
 * value that isn't the resolved secret itself, and the error path never
 * echoes the (absent) value -- only the variable *name* -- so a missing key
 * can't leak a secret through an error message or log line.
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

// Every failure code that means "the local Ollama server could not be
// reached" -- not just an outright refusal. `ETIMEDOUT` and `EHOSTUNREACH`
// are the equivalent plain Node/OS errno codes for a connect-level timeout /
// unreachable host; `UND_ERR_CONNECT_TIMEOUT` is undici's own connect-timeout
// code.
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * True for the shape a Node/undici `fetch` rejection takes when the local
 * Ollama server can't be reached at all -- refused, timed out connecting, or
 * otherwise unreachable (see `UNREACHABLE_CODES` above) -- walked through
 * `.cause` (and `AggregateError.errors`, which undici uses for
 * multi-address connection attempts) since `fetch` itself always throws a
 * generic `TypeError: fetch failed` wrapper.
 */
function isConnectionRefused(err: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && UNREACHABLE_CODES.has(code)) return true;
    const cause = (current as { cause?: unknown }).cause;
    if (cause) queue.push(cause);
    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors)) queue.push(...errors);
  }
  return false;
}

function wrapOllamaConnectionError(err: unknown, modelConfig: Model): never {
  if (modelConfig.provider === "ollama" && isConnectionRefused(err)) {
    throw new OllamaUnavailableError(modelConfig.base_url ?? DEFAULT_OLLAMA_BASE_URL, {
      cause: err,
    });
  }
  throw err;
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
 * `@mastra/core` Agent (see `createMastraModelClient`).
 */
export interface ModelClient {
  generateText(input: GenerateTextInput): Promise<string>;
  generateStructured<T>(input: GenerateStructuredInput<T>): Promise<T>;
}

export interface CreateMastraModelClientOptions {
  /**
   * Overrides the `fetch` implementation the underlying AI SDK provider
   * uses -- mainly useful for testing this file itself; production callers
   * omit this.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Builds a real Mastra `Agent` from the spec's role/goal/model and wraps it
 * behind `ModelClient`. Throws synchronously -- before any network call is
 * made -- on a missing/invalid model config or a missing BYOK env var, so a
 * caller surfaces a specific, immediate error rather than a run that fails
 * deep inside its first step. `api_key` is only resolved/required for the
 * cloud providers; "ollama" has none to resolve.
 */
export function createMastraModelClient(
  spec: AgentSpec,
  env: NodeJS.ProcessEnv = process.env,
  options: CreateMastraModelClientOptions = {},
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

  let apiKey = "";
  if (CLOUD_PROVIDERS.has(modelConfig.provider)) {
    if (!modelConfig.api_key) {
      throw new Error(
        `Model provider "${modelConfig.provider}" requires \`agent.model.api_key\` (a \${ENV_VAR} placeholder).`,
      );
    }
    apiKey = resolveEnvVarPlaceholder(modelConfig.api_key, modelConfig.provider, env);
  }

  const model = factory(modelConfig.name, {
    apiKey,
    baseUrl: modelConfig.base_url,
    fetchImpl: options.fetchImpl,
  });

  const agent = new Agent({
    id: spec.agent.id,
    name: spec.agent.name,
    instructions: `Role: ${spec.agent.role}\nGoal: ${spec.agent.goal}`,
    model,
  });

  return {
    async generateText({ instructions, prompt }) {
      try {
        const result = await agent.generate(prompt, { instructions });
        return result.text;
      } catch (err) {
        wrapOllamaConnectionError(err, modelConfig);
      }
    },
    async generateStructured<T>({ instructions, prompt, schema }: GenerateStructuredInput<T>) {
      try {
        const result = await agent.generate(prompt, { instructions, structuredOutput: { schema } });
        return result.object as T;
      } catch (err) {
        wrapOllamaConnectionError(err, modelConfig);
      }
    },
  };
}
