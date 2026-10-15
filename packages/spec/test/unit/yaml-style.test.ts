import { Document } from "yaml";
import { describe, expect, it } from "vitest";
import { parseSpec, toYamlString } from "../../src/parse.js";

// KAM-157: re-serialising an untouched document must be a byte-for-byte no-op for the styles an author writes
// by hand, so a canvas save does not reformat a spec (ADR-0007's diff-clean goal).

const wrap = (body: string) => `version: "1.1"
agent:
  id: a
  name: A
  role: R
  goal: G
${body}
  workflow:
    - step: s
      action: write
`;
const roundTrip = (source: string) => {
  const result = parseSpec(source);
  // Validation is not the point here, only that what was parsed is written back the way it was.
  return toYamlString(result.doc);
};

const LONG =
  "$count($filter(trigger.alerts, function($a) { $a.status = 'firing' and $a.labels.severity = 'critical' })) > 0";

describe("YAML serialisation keeps hand-authored style", () => {
  it("does not refold a long double-quoted scalar", () => {
    const source = wrap(`  trigger:
    type: webhook
    when: "${LONG}"`);
    expect(roundTrip(source)).toBe(source);
  });

  it("does not refold a long plain scalar", () => {
    const goal = Array.from({ length: 40 }, () => "word").join(" ");
    const source = wrap("").replace("goal: G", `goal: ${goal}`);
    expect(roundTrip(source)).toBe(source);
  });

  // `map` and `seq` are the padding inside the braces and brackets: "" is tight, " " is padded.
  const flow = (map: string, seq: string) =>
    wrap(`  tools:
    - name: t
      action: component
      use: kampong/slack@1.0.0
      op: post_message
      with: {${map}channel: x, text: hello${map}}
      config: {${map}region: us${map}}
  guardrails: {${map}confidence_threshold: 0.8${map}}
  knowledge_base: [${seq}one, two${seq}]`);

  it.each([
    ["padded maps and tight sequences (prettier)", " ", ""],
    ["tight maps and tight sequences", "", ""],
    ["padded maps and padded sequences", " ", " "],
    ["tight maps and padded sequences", "", " "],
  ])("keeps %s as written", (_, map, seq) => {
    const source = flow(map, seq);
    expect(roundTrip(source)).toBe(source);
  });

  it("keeps the style after the canvas edits a value, and writes a new document tight", () => {
    const source = flow(" ", "");
    const result = parseSpec(source);
    result.doc.setIn(["agent", "goal"], "Changed");
    expect(toYamlString(result.doc)).toBe(source.replace("goal: G", "goal: Changed"));
    expect(toYamlString(new Document({ a: { b: 1 }, c: [1, 2] }))).toBe(
      "a:\n  b: 1\nc:\n  - 1\n  - 2\n",
    );
  });

  it("writes a hand-wrapped >- as one line per paragraph: the value is kept and a second save changes nothing", () => {
    const source = wrap("").replace(
      "goal: G",
      "goal: >-\n    first line of the goal\n    second line of the goal\n\n    new paragraph here",
    );
    const once = roundTrip(source);
    expect(once).toContain(
      "    first line of the goal second line of the goal\n\n    new paragraph here",
    );
    expect(parseSpec(once).spec?.agent.goal).toBe(parseSpec(source).spec?.agent.goal);
    expect(roundTrip(once)).toBe(once);
  });

  it("keeps a | block scalar's line breaks", () => {
    const source = wrap("").replace("goal: G", "goal: |-\n    line one\n    line two");
    expect(roundTrip(source)).toBe(source);
  });
});
