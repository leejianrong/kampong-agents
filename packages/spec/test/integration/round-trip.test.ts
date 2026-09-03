import { describe, expect, it } from "vitest";

// Placeholder for the highest-leverage test named in PLAN.md's "Testing
// approach": for a fixture corpus of specs, parse -> render -> mutate ->
// serialize -> re-parse must be a fixed point (KAN-1102 / SLICES.md V1).
// This is an integration-layer test (spans the parser, the canvas model,
// and re-serialization) rather than a pure unit test.
describe.todo("AgentSpec round-trip duality (SLICES.md V1)", () => {
  it.todo("parse -> render -> mutate -> serialize -> re-parse is lossless for every fixture");
});

describe("integration test layer wiring", () => {
  it("runs as part of the integration project", () => {
    expect(true).toBe(true);
  });
});
