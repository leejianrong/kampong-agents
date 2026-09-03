import { describe, expect, it } from "vitest";
import { OPENROUTER_BASE_URL, UnknownModelProviderError } from "../../src/model.js";

// Fast, no-infra checks for the "openrouter" entry added to model.ts's
// PROVIDERS map (follow-up to the V3 Ollama adapter, KAN-1112). The
// provider-construction / BYOK-resolution paths for anthropic/openai/ollama
// are exercised at the integration layer (test/integration/byok.test.ts,
// ollama.test.ts) since they cross into @kampong/spec's `AgentSpec` shape
// and (for ollama/openrouter) the `@ai-sdk/openai` provider client -- see
// this repo's test/integration/openrouter.test.ts and byok.test.ts's
// openrouter describe block for that coverage. This file covers what's
// genuinely unit-testable in isolation: the module's own constants and
// error messages.

describe("openrouter provider -- unit-level checks", () => {
  it("exposes a fixed OpenRouter API base URL (no per-spec override, unlike ollama's base_url)", () => {
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("lists openrouter among the providers named in UnknownModelProviderError's message", () => {
    const error = new UnknownModelProviderError("azure");
    expect(error.message).toContain("openrouter");
    expect(error.message).toContain("anthropic");
    expect(error.message).toContain("openai");
    expect(error.message).toContain("ollama");
  });
});
