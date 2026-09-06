import { describe, expect, it } from "vitest";
import { runStartupWiringCheck } from "../../src/wiring-check.js";

// KAN-1221: this package's whole point (at this scaffold stage) is proving
// @kampong/spec and @kampong/engine resolve through packages/server's own
// dist/ build output -- AGENTS.md warns this exact cross-package resolution
// silently breaks if the build order is wrong. `runStartupWiringCheck`
// (invoked from server.ts's createServer, exercised end-to-end there) is
// unit-tested directly here so a regression in either import fails a fast,
// specific test rather than only the vaguer "createServer doesn't throw"
// integration-shaped check in server.test.ts.

describe("runStartupWiringCheck", () => {
  it("succeeds, reporting both the spec validator and model client as ok", () => {
    expect(runStartupWiringCheck()).toEqual({ specValidator: "ok", modelClient: "ok" });
  });

  it("never makes a live network call (completes without a reachable Ollama server)", async () => {
    // No fetch mocking, no live Ollama server available in this test
    // environment -- if this ever regressed into actually invoking
    // generateText()/generateStructured() over the network, it would hang
    // or reject here instead of resolving synchronously.
    const start = Date.now();
    runStartupWiringCheck();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
