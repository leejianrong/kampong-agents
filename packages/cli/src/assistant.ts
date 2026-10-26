import {
  assistantCatalogue,
  parseAssistantReply,
  planToOps,
  type AgentSpec,
  type AssistantDiff,
  type SpecOp,
} from "@kampong/spec";

// The workflow assistant's server side (KAM-249, ADR-0060): a prompt and the current spec go to an OpenAI-compatible
// chat endpoint, the reply is read as a plan of edits, and the plan is proved against AgentSpec on a copy. Nothing is
// applied here and nothing is written. A call that fails fails visibly (ADR-0004): there is one endpoint, no fallback
// to another provider, and an unreachable one is an error the person reads.

export interface AssistantConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Where it came from, in words that hold no secret: for messages, doctor and the first-use notice. */
  from: string;
  timeoutMs: number;
}

export type ConfigResult =
  | { ok: true; config: AssistantConfig }
  | { ok: false; code: "not_configured" | "incomplete" | "unsupported"; error: string };

const OPENROUTER = "https://openrouter.ai/api/v1";
const OPENAI = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 60_000;
const trimSlash = (url: string) => url.replace(/\/+$/, "");
const get = (env: NodeJS.ProcessEnv, name: string): string | undefined =>
  env[name] !== undefined && env[name] !== "" ? env[name] : undefined;
const placeholderName = (value: string | undefined) =>
  value === undefined ? undefined : /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];

/**
 * Where the assistant talks to, in the repo's order of preference (OpenRouter, then any OpenAI-compatible endpoint,
 * never a direct Anthropic key): an explicit KAMPONG_ASSISTANT_* endpoint, then OPENROUTER_API_KEY, then OPENAI_API_KEY
 * (with OPENAI_BASE_URL if set), then the spec's own model block when it names one of those or a local Ollama. The
 * model is KAMPONG_ASSISTANT_MODEL, else the spec's model name, so a person who has set up a model for a run has set up
 * the assistant too.
 */
export function resolveAssistantConfig(env: NodeJS.ProcessEnv, spec?: AgentSpec): ConfigResult {
  const specModel = spec?.agent.model;
  const model = get(env, "KAMPONG_ASSISTANT_MODEL") ?? specModel?.name;
  const timeoutMs = specModel?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const needModel = (from: string): ConfigResult => ({
    ok: false,
    code: "incomplete",
    error: `The assistant is set up through ${from}, but no model is named. Set KAMPONG_ASSISTANT_MODEL.`,
  });

  const explicit = get(env, "KAMPONG_ASSISTANT_BASE_URL");
  if (explicit !== undefined) {
    if (model === undefined) return needModel("KAMPONG_ASSISTANT_BASE_URL");
    const key = get(env, "KAMPONG_ASSISTANT_API_KEY");
    return {
      ok: true,
      config: {
        baseUrl: trimSlash(explicit),
        ...(key !== undefined && { apiKey: key }),
        model,
        from: "KAMPONG_ASSISTANT_BASE_URL",
        timeoutMs,
      },
    };
  }
  const openrouter = get(env, "OPENROUTER_API_KEY");
  if (openrouter !== undefined) {
    if (model === undefined) return needModel("OPENROUTER_API_KEY");
    return {
      ok: true,
      config: {
        baseUrl: OPENROUTER,
        apiKey: openrouter,
        model,
        from: "OPENROUTER_API_KEY",
        timeoutMs,
      },
    };
  }
  const openai = get(env, "OPENAI_API_KEY");
  if (openai !== undefined) {
    if (model === undefined) return needModel("OPENAI_API_KEY");
    return {
      ok: true,
      config: {
        baseUrl: trimSlash(get(env, "OPENAI_BASE_URL") ?? OPENAI),
        apiKey: openai,
        model,
        from: "OPENAI_API_KEY",
        timeoutMs,
      },
    };
  }
  if (specModel?.provider === "ollama") {
    return {
      ok: true,
      config: {
        baseUrl: `${trimSlash(specModel.base_url ?? "http://localhost:11434")}/v1`,
        model: model!,
        from: "the workflow's local model",
        timeoutMs,
      },
    };
  }
  if (specModel?.provider === "anthropic") {
    return {
      ok: false,
      code: "unsupported",
      error:
        "The assistant talks to OpenAI-compatible endpoints, and a direct Anthropic key is not one. Set OPENROUTER_API_KEY, or KAMPONG_ASSISTANT_BASE_URL with a key and model.",
    };
  }
  const named = placeholderName(specModel?.api_key);
  const keyed = named !== undefined ? get(env, named) : undefined;
  if (
    keyed !== undefined &&
    model !== undefined &&
    (specModel?.provider === "openrouter" || specModel?.provider === "openai")
  ) {
    return {
      ok: true,
      config: {
        baseUrl:
          specModel.provider === "openrouter"
            ? OPENROUTER
            : trimSlash(get(env, "OPENAI_BASE_URL") ?? OPENAI),
        apiKey: keyed,
        model,
        from: `the workflow's model key (${named})`,
        timeoutMs,
      },
    };
  }
  return {
    ok: false,
    code: "not_configured",
    error:
      "The assistant is not set up. Set OPENROUTER_API_KEY (and KAMPONG_ASSISTANT_MODEL), or KAMPONG_ASSISTANT_BASE_URL, KAMPONG_ASSISTANT_API_KEY and KAMPONG_ASSISTANT_MODEL for any OpenAI-compatible endpoint.",
  };
}

/** The host a config talks to, for the notice that says where a prompt and spec are sent. */
export function assistantHost(config: AssistantConfig): string {
  try {
    return new URL(config.baseUrl).host;
  } catch {
    return config.baseUrl;
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class AssistantCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantCallError";
  }
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const scrub = (text: string, config: AssistantConfig) =>
  config.apiKey ? text.split(config.apiKey).join("[key]") : text;

/** One chat completion. A failure is an AssistantCallError whose message says what happened and holds no secret. */
export async function chat(
  config: AssistantConfig,
  messages: ChatMessage[],
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const host = assistantHost(config);
  let res: Response;
  try {
    res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey !== undefined && { authorization: `Bearer ${config.apiKey}` }),
        ...(host === "openrouter.ai" && {
          "HTTP-Referer": "https://github.com/leejianrong/kampong-agents",
          "X-Title": "Kampong Agents",
        }),
      },
      body: JSON.stringify({ model: config.model, messages, temperature: 0.2 }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new AssistantCallError(
      timedOut
        ? `The assistant endpoint ${host} did not answer within ${config.timeoutMs / 1000}s.`
        : `Could not reach the assistant endpoint ${host}: ${scrub(err instanceof Error ? err.message : String(err), config)}`,
    );
  }
  if (!res.ok) {
    const body = scrub((await res.text().catch(() => "")).slice(0, 300), config);
    throw new AssistantCallError(
      `The assistant endpoint ${host} answered ${res.status}${body ? `: ${body}` : "."}`,
    );
  }
  const json = (await res.json().catch(() => undefined)) as
    { choices?: { message?: { content?: unknown } }[] } | undefined;
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new AssistantCallError(`The assistant endpoint ${host} sent an empty answer.`);
  }
  return content;
}

const PLAN_FORMAT = `Reply with ONE JSON object and nothing else:
{ "summary": "<one or two sentences for the person: what this does>",
  "edits": [ <edit>, ... ] }

Each edit is one of:
  { "kind": "add_step", "step": {<a step>}, "place": {"in": "workflow" | {"step": "<loop or branch step>", "slot": "steps"|"then"|"else"|"cases"|"default", "key": "<case value, for cases>"}, "index": <0-based, optional: default the end>} }
  { "kind": "replace_step", "step": "<existing name>", "with": {<the whole step, same name>} }
  { "kind": "remove_step", "step": "<name>" }
  { "kind": "move_step", "step": "<name>", "to": {<a place as above>} }
  { "kind": "rename_step", "step": "<name>", "to": "<new name>" }
  { "kind": "add_tool", "tool": {<a tool>} }
  { "kind": "replace_tool", "tool": "<existing name>", "with": {<the whole tool, same name>} }
  { "kind": "remove_tool", "tool": "<name>" }
  { "kind": "rename_tool", "tool": "<name>", "to": "<new name>" }
  { "kind": "set_agent", "fields": { "name"?, "role"?, "goal"?, "trigger"?, "guardrails"? } }
  { "kind": "set_var", "name": "<var>", "var": {"type": "string"|"number"|"list", "default": ..., "description"?} }
  { "kind": "remove_var", "name": "<var>" }
  { "kind": "upgrade_to_1_1" }   (only when the workflow is version 1.0 and you need a 1.1 step or var)

Rules:
- Step names and tool names are unique. A step reads an earlier step's output as {{ name.field }} in text, or as name.field in a JSONata expression (transform, validate, branch, foreach items).
- A tool step needs its tool declared first: add the tool, then the step that calls it.
- Never write a secret. A credential is only \${ENV_NAME}. Do not touch the model block.
- Change as little as the request needs. Keep existing step and tool names unless asked.
- Data steps (transform, validate, dedupe), foreach, branch and stop need version 1.1.
- For a new workflow, replace the placeholder step and set the agent's name, role and goal.`;

export function buildSystemPrompt(components: { use: string; ops: string[] }[]): string {
  return `You edit workflows for Kampong Agents, an agent-workflow builder. A workflow is a YAML spec. The person describes what they want in plain words; you answer with edits to the spec, which they review before anything changes.\n\n${PLAN_FORMAT}\n\n${assistantCatalogue(components)}`;
}

export interface AssistantRequest {
  prompt: string;
  /** The workflow file as it is now. */
  source: string;
  components?: { use: string; ops: string[] }[];
}

export type AssistantResult =
  | {
      success: true;
      summary: string;
      ops: SpecOp[];
      diff: AssistantDiff;
      /** The file as it would be after the ops, for a preview. */
      source: string;
      /** How many times the endpoint was asked: 2 when the first plan did not apply and it was told why. */
      attempts: number;
    }
  | { success: false; kind: "invalid"; errors: string[]; reply: string; attempts: number }
  | { success: false; kind: "unavailable"; error: string };

const MAX_ATTEMPTS = 2;

/**
 * Asks for a plan and proves it. If the first plan does not parse or does not apply, the endpoint is told why once
 * and asked again; a second failure is reported and nothing is returned to apply.
 */
export async function proposeEdits(
  config: AssistantConfig,
  request: AssistantRequest,
  fetchImpl: FetchLike = fetch,
): Promise<AssistantResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(request.components ?? []) },
    {
      role: "user",
      content: `Current workflow:\n\`\`\`yaml\n${request.source}\n\`\`\`\n\nRequest: ${request.prompt}`,
    },
  ];
  let errors: string[] = [];
  let reply = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      reply = await chat(config, messages, fetchImpl);
    } catch (err) {
      return {
        success: false,
        kind: "unavailable",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const parsed = parseAssistantReply(reply);
    if (parsed.ok) {
      const planned = planToOps(request.source, parsed.plan);
      if (planned.success) {
        return {
          success: true,
          summary: parsed.plan.summary,
          ops: planned.ops,
          diff: planned.diff,
          source: planned.source,
          attempts: attempt,
        };
      }
      errors = planned.errors;
    } else {
      errors = [parsed.error];
    }
    messages.push(
      { role: "assistant", content: reply },
      {
        role: "user",
        content: `That plan could not be applied:\n${errors.map((e) => `- ${e}`).join("\n")}\nReply with a corrected plan, JSON only.`,
      },
    );
  }
  return { success: false, kind: "invalid", errors, reply, attempts: MAX_ATTEMPTS };
}
