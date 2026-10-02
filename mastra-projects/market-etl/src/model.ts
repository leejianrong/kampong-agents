import { createOpenAI } from "@ai-sdk/openai";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://github.com/leejianrong/kampong-agents",
  "X-Title": "market-etl",
};

// Every model call in every mastra-projects demo goes through OpenRouter,
// never a direct ANTHROPIC_API_KEY -- standing preference, see
// mastra-projects/docs/adr/0005. Same house style as kampong-agents' own
// engine (packages/engine/src/model.ts): straight through the Vercel AI SDK
// provider interface, a missing key fails loudly.
export function resolveModel(modelName = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini") {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set (see .env.example).");
  }
  // `.chat(name)`, not the bare factory call -- OpenRouter only implements
  // the classic Chat Completions API, not OpenAI's newer Responses API.
  // Same gotcha already hit and documented in pr-review-swarm/src/model.ts
  // and kampong-agents' own packages/engine/src/model.ts.
  return createOpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    headers: OPENROUTER_HEADERS,
  }).chat(modelName);
}
