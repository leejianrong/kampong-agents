import { describe, expect, it, vi } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import type { DbClient } from "../../src/db/client.js";
import { resolveWorkspaceModelClient } from "../../src/model/resolve.js";
import { createGuardedFetch } from "../../src/run/ssrf-guard.js";

// KAM-337: a spec may name its own `agent.model.base_url`, so the model client must go through the same egress rule
// as a tool. Ollama needs no key, so no database is touched.

function specWith(baseUrl: string): AgentSpec {
  return {
    version: "1.0",
    agent: {
      id: "a",
      name: "A",
      role: "r",
      goal: "g",
      model: { provider: "ollama", name: "llama3", base_url: baseUrl },
      workflow: [{ step: "greet", action: "say_hello" }],
    },
  } as unknown as AgentSpec;
}

const modelFetch = (guard: ReturnType<typeof createGuardedFetch>): typeof fetch =>
  ((input, init) => guard(input, init, { toolName: "model" })) as typeof fetch;

async function generate(baseUrl: string, guard: ReturnType<typeof createGuardedFetch>) {
  const client = await resolveWorkspaceModelClient({
    db: {} as DbClient,
    workspaceId: "w",
    spec: specWith(baseUrl),
    env: {},
    fetchImpl: modelFetch(guard),
  });
  return client.generateText({ instructions: "x", prompt: "y" });
}

describe("model calls and the egress guard (KAM-337)", () => {
  it.each([
    ["the cloud metadata address", "http://169.254.169.254:11434"],
    ["loopback", "http://127.0.0.1:11434"],
    ["a cluster-private address", "http://10.1.2.3:11434"],
  ])("refuses %s as a model base_url, without sending anything", async (_name, url) => {
    const base = vi.fn(async () => new Response("{}"));
    await expect(generate(url, createGuardedFetch({ base }))).rejects.toThrow(/blocked/);
    expect(base).not.toHaveBeenCalled();
  });

  it("lets an address the operator allow-listed through (the self-host gateway)", async () => {
    const base = vi.fn(async () => new Response("{}", { status: 500 }));
    await generate(
      "http://10.1.2.3:11434",
      createGuardedFetch({ base, allowHosts: ["10.1.2.3"] }),
    ).catch(() => undefined);
    expect(base).toHaveBeenCalled();
  });
});
