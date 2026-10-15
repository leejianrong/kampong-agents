import { describe, expect, it } from "vitest";
import { parseSpec, toYamlString } from "../../src/parse.js";

// KAM-117: `agent.trigger` of type poll (a component op, an interval, an id and a dedupe enum), 1.1 only.

const POLL = `    type: poll
    every: 5m
    use: kampong/gmail-imap@1.0.0
    op: list_unseen
    with:
      mailbox: INBOX
    items: messages
    id: uid
    dedupe: greatest`;
const spec = (version: string, trigger: string) => `version: "${version}"
agent:
  id: a
  name: A
  role: R
  goal: G
  trigger:
${trigger}
  workflow:
    - step: s
      action: write
`;
const messages = (source: string) => parseSpec(source).errors.map((e) => e.message);

describe("poll trigger", () => {
  it("accepts a poll and round-trips", () => {
    const source = spec("1.1", POLL);
    const result = parseSpec(source);
    expect(result.errors).toEqual([]);
    expect(result.spec?.agent.trigger).toMatchObject({
      type: "poll",
      every: "5m",
      dedupe: "greatest",
      id: "uid",
    });
    expect(toYamlString(result.doc)).toBe(source);
  });

  it("needs version 1.1", () => {
    expect(messages(spec("1.0", POLL))).toContain('a poll trigger needs version "1.1"');
  });

  it("refuses an interval that is not one", () => {
    expect(messages(spec("1.1", POLL.replace("every: 5m", "every: soon")))).toEqual([
      expect.stringContaining("not an interval"),
    ]);
  });

  it("refuses a dedupe outside the enum", () => {
    expect(parseSpec(spec("1.1", POLL.replace("greatest", "newest"))).errors).not.toEqual([]);
  });

  it("needs a window for time_window and refuses one otherwise", () => {
    const windowed = POLL.replace("greatest", "time_window");
    expect(messages(spec("1.1", windowed))).toContain(
      "dedupe time_window needs a window (e.g. 24h)",
    );
    expect(messages(spec("1.1", `${windowed}\n    window: 24h`))).toEqual([]);
    expect(messages(spec("1.1", `${POLL}\n    window: 24h`))).toContain(
      "window only applies to dedupe time_window",
    );
  });

  it("needs an id, and checks the expressions' syntax", () => {
    expect(parseSpec(spec("1.1", POLL.replace("    id: uid\n", ""))).errors).not.toEqual([]);
    expect(messages(spec("1.1", POLL.replace("id: uid", 'id: "uid +"')))).toEqual([
      expect.stringContaining("id"),
    ]);
    expect(messages(spec("1.1", POLL.replace("items: messages", 'items: "messages["')))).toEqual([
      expect.stringContaining("items"),
    ]);
  });

  it("refuses a literal secret", () => {
    const withSecret = `${POLL}\n    secrets:\n      password: hunter2`;
    expect(parseSpec(spec("1.1", withSecret)).errors).not.toEqual([]);
  });
});
