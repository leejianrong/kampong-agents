import { describe, expect, it } from "vitest";
import type { Tool } from "@kampong/spec";
import { createFirstPartyRegistry, desugarLegacyTool } from "@kampong/engine";
import { digestOfFiles, requiredComponentRefs } from "../../src/components.js";

// KAN-1886: the exporter keeps two small copies of engine knowledge (which components the legacy tool
// kinds run on, and how a component's digest is computed). These pin them to the engine.

const spec = (tool: unknown) =>
  ({
    version: "1.0",
    agent: { id: "a", name: "A", role: "R", goal: "G", tools: [tool], workflow: [] },
  }) as never;

describe("exporter agrees with the engine", () => {
  it("requires the same first-party component for a legacy tool as the engine desugars it to", () => {
    const tools: Tool[] = [
      { name: "s", action: "slack_post_message", token: "${T}", channel: "#c", text: "x" },
      { name: "g", action: "gmail_send", token: "${T}", to: "a@b.c", subject: "s", body: "b" },
    ];
    for (const tool of tools) {
      const desugared = desugarLegacyTool(tool)!;
      expect(requiredComponentRefs(spec(tool))).toEqual([desugared.use]);
    }
  });

  it("computes a component's digest the way the engine's registry does", async () => {
    const registry = createFirstPartyRegistry();
    for (const summary of await registry.list()) {
      const resolved = await registry.resolve(summary.id, summary.version);
      expect(digestOfFiles(Object.fromEntries(resolved.files!))).toBe(resolved.digest);
    }
  });
});
