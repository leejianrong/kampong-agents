import { describe, expect, it } from "vitest";
import { parseSpec, toYamlString } from "../../src/parse.js";

// KAM-107: `knowledge_base` items can opt in with `mode: inject`.

const spec = (version: string, item: string) => `version: "${version}"
agent:
  id: a
  name: A
  role: R
  goal: G
  knowledge_base:
${item}
  workflow:
    - step: s
      action: write
`;
const messages = (source: string) => parseSpec(source).errors.map((e) => e.message);

describe("knowledge_base mode: inject", () => {
  it("is accepted for text and url in 1.1 and round-trips", () => {
    const source = spec(
      "1.1",
      '    - type: text\n      source: "Refunds take 5 days."\n      mode: inject\n    - type: url\n      source: "https://docs.example.com/faq"\n      mode: inject',
    );
    const result = parseSpec(source);
    expect(result.errors).toEqual([]);
    expect(toYamlString(result.doc)).toBe(source);
  });

  it("needs version 1.1", () => {
    expect(
      messages(spec("1.0", '    - type: text\n      source: "x"\n      mode: inject')),
    ).toContain('mode needs version "1.1"');
  });

  it("is refused for a pdf, which cannot be injected yet", () => {
    expect(
      messages(
        spec("1.1", '    - type: pdf\n      source: "./policy.pdf"\n      mode: inject'),
      ).join(" "),
    ).toContain("a pdf source cannot be injected yet");
  });

  it("refuses any other mode", () => {
    expect(
      parseSpec(spec("1.1", '    - type: text\n      source: "x"\n      mode: retrieve')).success,
    ).toBe(false);
  });

  it("leaves a source with no mode valid in 1.0, as before", () => {
    expect(messages(spec("1.0", '    - type: pdf\n      source: "./policy.pdf"'))).toEqual([]);
  });
});
