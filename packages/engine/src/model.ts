import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { AgentSpec, Model, ModelProvider } from "@kampong/spec";
import type { z } from "zod";

// Model resolution (PLAN.md Shape S3, ADR-0003, ADR-0004, SLICES.md V2
// KAN-1103/1106, V3 KAN-1112). Kept as a small name -> factory map, per
// AGENTS.md, so the Ollama adapter below is a one-entry addition rather than
// a redesign of this file. Every provider resolves straight through its
// Vercel AI SDK package -- no gateway/proxy layer in v1 (ADR-0004).
//
// Ollama speaks an OpenAI-compatible `/v1` API, so rather than pull in a
// dedicated (and, as of this writing, less mature) Ollama Vercel-AI-SDK
// provider package, this reuses `@ai-sdk/openai` -- already a dependency --
// pointed at the local server with a throwaway api key (Ollama doesn't
// check it). This still goes straight through Mastra's AI SDK provider
// interface (ADR-0004); nothing about it is a gateway/proxy layer.
//
// OpenRouter is the same story for the same reason: it speaks an
// OpenAI-compatible Chat Completions API too (its own docs: "OpenRouter's
// request and response schemas are very similar to the OpenAI Chat API"),
// so it reuses `@ai-sdk/openai` rather than a dedicated OpenRouter SDK
// package. Unlike Ollama it's a real cloud service with a fixed host --
// no per-spec `base_url` override -- and it does require a BYOK `api_key`.

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

// KAN-1185 (R6, ADR-0004): a model call with no timeout can hang a `kampong
// run` indefinitely with zero progress output -- confirmed via a live repro
// against a real, unusually slow Ollama daemon. Tens-of-seconds is the right
// order of magnitude for a real LLM call (long enough not to false-positive
// on a slow-but-alive provider, short enough that a CI job notices a hang
// instead of burning its own job timeout). Overridable per spec
// (`agent.model.timeout_ms`) and, taking precedence over that, per CLI
// invocation (`kampong run --timeout <ms>`) so a CI job can tune it without
// editing the spec file.
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;

// OpenRouter's API host is fixed (unlike Ollama's, which is typically local
// and sometimes remote/tunneled) -- no spec-level override for this one.
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// OpenRouter's docs recommend (not require) these for attribution on
// openrouter.ai's own leaderboards/rankings; harmless to always send.
const OPENROUTER_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://github.com/leejianrong/kampong-agents",
  "X-Title": "Kampong Agents",
};

// Which providers require a real BYOK `${ENV_VAR}` api_key (schema.ts made
// `api_key` optional across the board specifically so "ollama" -- which has
// no key to check -- doesn't need to fake one; this is where that split is
// actually enforced).
const CLOUD_PROVIDERS: ReadonlySet<ModelProvider> = new Set(["anthropic", "openai", "openrouter"]);

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
  // Verified empirically against a stub server before landing this; see the
  // PR description for the request Ollama would actually 404 on otherwise.
  ollama: (name, { baseUrl, fetchImpl }) =>
    createOpenAI({
      apiKey: "ollama",
      baseURL: `${baseUrl ?? DEFAULT_OLLAMA_BASE_URL}/v1`,
      fetch: fetchImpl,
    }).chat(name),
  // Same `.chat(name)` reasoning as Ollama above, verified against
  // OpenRouter's own docs rather than assumed just because Ollama needed
  // it: OpenRouter documents a single `POST /api/v1/chat/completions`
  // endpoint (Chat Completions shape) and does not implement OpenAI's
  // newer Responses API (`POST /v1/responses`) that the bare
  // `createOpenAI(...)(name)` factory call defaults to. See
  // test/integration/openrouter.test.ts for a fake-server regression test
  // that would catch a regression back to the bare (Responses-API) call.
  openrouter: (name, { apiKey, fetchImpl }) =>
    createOpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      headers: OPENROUTER_HEADERS,
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
 * The specific, actionable error thrown when the local Ollama server can't
 * be reached (AGENTS.md / PLAN.md Q8: "a local model that's unavailable is
 * a hard, visible error -- never a silent fallback to a paid cloud API").
 * Unlike a missing BYOK key, this can only be detected at call time -- there
 * is no key to check synchronously -- so it's raised from inside
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
 * The specific, actionable error thrown when a model call runs longer than
 * its configured timeout (KAN-1185, R6: "CLI commands scriptable/CI-friendly
 * with meaningful exit codes" -- a silent, indefinite hang is the opposite of
 * that). Follows ADR-0004's "a failed call fails visibly, never a silent
 * retry/fallback" spirit: this is never caught and retried, just surfaced
 * with a clear, specific message naming the provider and the exact timeout
 * that elapsed, instead of a generic `TypeError: fetch failed` or an
 * indefinite hang.
 */
export class ModelCallTimeoutError extends Error {
  constructor(
    public readonly provider: string,
    public readonly timeoutMs: number,
    options?: { cause?: unknown },
  ) {
    super(
      `Model call to "${provider}" timed out after ${timeoutMs}ms. Increase the timeout via ` +
        "`agent.model.timeout_ms` in the spec, or pass `--timeout <ms>` to `kampong run`, " +
        "or check that the provider is actually responding.",
      options,
    );
    this.name = "ModelCallTimeoutError";
  }
}

/**
 * Wraps a `fetch` implementation so every request it makes is aborted after
 * `timeoutMs` -- the actual network-call layer, not just client
 * construction (a `fetch` option threaded through to `createAnthropic`/
 * `createOpenAI` does nothing on its own unless something actually attaches
 * an `AbortSignal` to each request, which is what this does). A caller-
 * supplied `signal` in `init` (the AI SDK doesn't pass one today, but a
 * future version might) is honored too -- either one aborting the request is
 * enough -- while `timedOut` specifically tracks *our* timer firing, so a
 * caller-initiated abort is never misreported as a timeout.
 */
function createTimeoutFetch(
  fetchImpl: typeof fetch | undefined,
  timeoutMs: number,
  provider: string,
): typeof fetch {
  const baseFetch = fetchImpl ?? fetch;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    // `timer` would otherwise keep the process (and a test runner) alive
    // for the full timeout even after the request settles normally.
    timer.unref?.();

    const callerSignal = init?.signal;
    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    try {
      return await baseFetch(input, { ...init, signal: controller.signal });
    } catch (err) {
      if (timedOut) {
        throw new ModelCallTimeoutError(provider, timeoutMs, { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }) as typeof fetch;
}

/**
 * Finds a `ModelCallTimeoutError` anywhere in `err`'s `.cause` chain (and
 * `AggregateError.errors`) -- same walk shape as `isConnectionRefused` below.
 * Whatever the AI SDK/Mastra wrap a fetch rejection into on its way back up
 * through `agent.generate(...)`, the original `ModelCallTimeoutError` thrown
 * by `createTimeoutFetch` above is preserved somewhere in that chain (as a
 * `.cause`, directly or nested), so unwrapping it here -- rather than
 * depending on exactly how many layers of wrapping happen to exist today --
 * is what lets the CLI/caller see the specific, actionable message and type
 * instead of whatever generic wrapper error sits on top of it.
 */
function findTimeoutError(err: unknown): ModelCallTimeoutError | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof ModelCallTimeoutError) return current;
    const cause = (current as { cause?: unknown }).cause;
    if (cause) queue.push(cause);
    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors)) queue.push(...errors);
  }
  return undefined;
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

// Every failure code that means "the local Ollama server could not be
// reached" -- not just an outright refusal. Verified empirically (see the
// PR description / commit message for finding #7) rather than guessed:
// pointing Node's built-in (undici-backed) `fetch` at a non-routable address
// with a short connect timeout reproduces a real connect-timeout failure,
// and its `.cause` chain bottoms out in an undici `ConnectTimeoutError` with
// `code: "UND_ERR_CONNECT_TIMEOUT"` -- distinct from the plain OS-level
// `ECONNREFUSED` the original code already recognized. `ETIMEDOUT` and
// `EHOSTUNREACH` are the equivalent plain Node/OS errno codes for a
// connect-level timeout / unreachable host respectively (e.g. when Node's
// own TCP-level timeout fires, or a lower-level network stack reports the
// host unreachable, rather than undici's own connect-timeout machinery).
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
 * Ollama server can't be reached at all -- refused, timed out connecting,
 * or otherwise unreachable (see `UNREACHABLE_CODES` above) -- walked through
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

/**
 * The single dispatch point both `generateText` and `generateStructured`
 * funnel a caught model-call error through: a timeout takes priority (it's
 * unambiguous -- `createTimeoutFetch` only ever produces this shape when its
 * own timer fired) over the connection-refused/unavailable check below it,
 * though in practice the two are mutually exclusive failure modes anyway.
 */
function rethrowModelCallError(err: unknown, modelConfig: Model): never {
  const timeoutError = findTimeoutError(err);
  if (timeoutError) throw timeoutError;
  wrapOllamaConnectionError(err, modelConfig);
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

export interface CreateMastraModelClientOptions {
  /**
   * Test-only seam (also used by e2e's offline proof, KAN-1113): overrides
   * the `fetch` implementation the underlying AI SDK provider uses, so a
   * connection failure -- or a canned response -- can be exercised
   * deterministically without a real Ollama server (or cloud endpoint)
   * reachable. Production callers omit this; `undefined` here just means
   * "use the AI SDK's own default fetch". Still gets wrapped in the
   * timeout-enforcing fetch below -- this is the *underlying* fetch a test
   * substitutes in, not an escape hatch from the timeout itself.
   */
  fetchImpl?: typeof fetch;
  /**
   * CLI override (`kampong run --timeout <ms>`, KAN-1185): takes precedence
   * over `agent.model.timeout_ms` on the spec, which in turn takes
   * precedence over `DEFAULT_MODEL_TIMEOUT_MS`, so a CI job can tune this
   * without editing the spec file.
   */
  timeoutMs?: number;
}

/**
 * Builds a real Mastra `Agent` from the spec's role/goal/model (KAN-1103)
 * and wraps it behind `ModelClient`. Throws synchronously -- before any
 * network call is made -- on a missing/invalid model config or a missing
 * BYOK env var, so a caller (the CLI server, `kampong run`) can surface a
 * specific, immediate error rather than a run that fails deep inside its
 * first step. `api_key` is only resolved/required for the cloud providers;
 * "ollama" has none to resolve.
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

  const timeoutMs = options.timeoutMs ?? modelConfig.timeout_ms ?? DEFAULT_MODEL_TIMEOUT_MS;
  const timeoutFetch = createTimeoutFetch(options.fetchImpl, timeoutMs, modelConfig.provider);

  const model = factory(modelConfig.name, {
    apiKey,
    baseUrl: modelConfig.base_url,
    fetchImpl: timeoutFetch,
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
        rethrowModelCallError(err, modelConfig);
      }
    },
    async generateStructured<T>({ instructions, prompt, schema }: GenerateStructuredInput<T>) {
      try {
        const result = await agent.generate(prompt, { instructions, structuredOutput: { schema } });
        return result.object as T;
      } catch (err) {
        rethrowModelCallError(err, modelConfig);
      }
    },
  };
}
