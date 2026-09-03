import { describe, expect, it } from "vitest";
import { classifyFileChange } from "../../src/watch-decision.js";

describe("classifyFileChange", () => {
  it("classifies the server's own write echoing back as 'self', regardless of pending state", () => {
    const result = classifyFileChange({
      pendingMutation: true,
      lastWrittenHash: "abc",
      newHash: "abc",
    });
    expect(result).toBe("self");
  });

  it("classifies an external change with no pending mutation as 'reload' (auto-reload default, ADR-0008)", () => {
    const result = classifyFileChange({
      pendingMutation: false,
      lastWrittenHash: "abc",
      newHash: "def",
    });
    expect(result).toBe("reload");
  });

  it("classifies an external change while a mutation is in flight as 'conflict' -- the one case that does not auto-resolve", () => {
    const result = classifyFileChange({
      pendingMutation: true,
      lastWrittenHash: "abc",
      newHash: "def",
    });
    expect(result).toBe("conflict");
  });

  it("classifies the very first external change (no prior write from this process) as 'reload'", () => {
    const result = classifyFileChange({
      pendingMutation: false,
      lastWrittenHash: null,
      newHash: "def",
    });
    expect(result).toBe("reload");
  });
});
