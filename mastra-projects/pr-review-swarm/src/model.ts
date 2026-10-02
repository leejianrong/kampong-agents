import { createOpenAI } from "@ai-sdk/openai";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// OpenRouter's own docs recommend (not require) these for attribution on
// openrouter.ai's leaderboards/rankings; harmless to always send.
const OPENROUTER_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://github.com/leejianrong/kampong-agents",
  "X-Title": "pr-review-swarm",
};

// Every model call in this demo goes through OpenRouter, never a direct
// ANTHROPIC_API_KEY -- a standing preference across all these projects, not
// specific to this one. Straight through the Vercel AI SDK provider
// interface, same house style as kampong-agents' own engine
// (packages/engine/src/model.ts) -- no extra gateway layer, a missing key
// fails loudly rather than falling back to anything.
export function resolveModel(modelName = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini") {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set (see .env.example).");
  }
  // `.chat(name)`, not the bare factory call: the bare call defaults to
  // OpenAI's newer Responses API (`POST /v1/responses`), which OpenRouter
  // does not implement -- it only serves the classic Chat Completions API.
  // Same gotcha kampong-agents' own engine already hit and documented in
  // packages/engine/src/model.ts.
  return createOpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    headers: OPENROUTER_HEADERS,
  }).chat(modelName);
}
