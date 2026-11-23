import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { createMastraModelClient } from "../../src/model.js";

// KAM-309: a failed model call used to dump about 60 lines of Mastra's own log (the whole HTTP error, with the
// request body) into the terminal of whoever ran `kampong serve`, on top of the error the run already carries.
// The call must still fail visibly, as an error the run reports; only the duplicate dump goes.

const spec = (): AgentSpec => ({
  version: "1.0",
  agent: {
    id: "a",
    name: "A",
    role: "r",
    goal: "g",
    model: { provider: "openrouter", name: "some/model", api_key: "${KEY}" },
    workflow: [{ step: "s", action: "say_hello" }],
  },
});

const upstreamError = (async () =>
  new Response(
    JSON.stringify({ error: { message: "Upstream is down for maintenance", code: 503 } }),
    {
      status: 503,
      headers: { "content-type": "application/json" },
    },
  )) as typeof fetch;

afterEach(() => vi.restoreAllMocks());

describe("a failed model call", () => {
  it("raises the error and does not dump the provider's log into the terminal", async () => {
    const written: string[] = [];
    for (const method of ["error", "warn", "log", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(" "));
      });
    }
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    const client = createMastraModelClient(spec(), { KEY: "k" }, { fetchImpl: upstreamError });
    await expect(client.generateText({ instructions: "x", prompt: "hi" })).rejects.toThrow();

    const text = written.join("\n");
    expect(text).not.toContain("Upstream LLM API error");
    expect(text).not.toContain("Error in agent stream");
  }, 15_000);
});
