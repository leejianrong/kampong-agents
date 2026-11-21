import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/assistant.js";

// KAM-290: the assistant is told to give each step it adds a plain-words title, so cards read as the person
// described them, not as ids.

describe("assistant system prompt", () => {
  it("asks for a plain-words title on every step it adds, and keeps the step name as the reference", () => {
    const prompt = buildSystemPrompt([]);
    expect(prompt).toContain("Give every step you add a `title`");
    expect(prompt).toContain('not "fetch_order"');
    expect(prompt).toContain("`step` name stays short and unique");
  });
});
