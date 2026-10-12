import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { generateAgentSpecJsonSchema } from "../../src/json-schema.js";

// KAN-1856: `agent.trigger` of type schedule (cron XOR every, tz, overlap), version 1.1 only.

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
const errors = (source: string) => parseSpec(source).errors;
const messages = (source: string) => errors(source).map((e) => e.message);

describe("schedule trigger", () => {
  it("accepts cron with a zone and overlap, and round-trips", () => {
    const source = spec(
      "1.1",
      "    type: schedule\n    cron: 0 6 * * 1-5\n    tz: Asia/Singapore\n    overlap: queue",
    );
    const result = parseSpec(source);
    expect(result.errors).toEqual([]);
    expect(result.spec?.agent.trigger).toEqual({
      type: "schedule",
      cron: "0 6 * * 1-5",
      tz: "Asia/Singapore",
      overlap: "queue",
    });
    expect(toYamlString(result.doc)).toBe(source);
  });

  it("accepts every", () => {
    expect(errors(spec("1.1", "    type: schedule\n    every: 15m"))).toEqual([]);
  });

  it("needs version 1.1", () => {
    expect(messages(spec("1.0", "    type: schedule\n    every: 15m"))).toContain(
      'a schedule trigger needs version "1.1"',
    );
  });

  it("needs exactly one of cron or every", () => {
    expect(messages(spec("1.1", "    type: schedule"))).toContain(
      "a schedule trigger needs exactly one of cron or every",
    );
    expect(
      messages(spec("1.1", "    type: schedule\n    cron: '* * * * *'\n    every: 5m")),
    ).toContain("a schedule trigger needs exactly one of cron or every");
  });

  it("refuses tz with every", () => {
    expect(messages(spec("1.1", "    type: schedule\n    every: 5m\n    tz: UTC"))).toContain(
      "tz only applies to a cron schedule",
    );
  });

  it("points at the line of a bad cron, interval or zone", () => {
    const cron = errors(spec("1.1", "    type: schedule\n    cron: 61 * * * *"));
    expect(cron).toHaveLength(1);
    expect(cron[0]).toMatchObject({
      path: ["agent", "trigger", "cron"],
      line: 9,
      message: "minute value 61 is out of range 0-59",
    });

    const every = errors(spec("1.1", "    type: schedule\n    every: soon"));
    expect(every[0]).toMatchObject({ path: ["agent", "trigger", "every"], line: 9 });
    expect(every[0]?.message).toContain("is not an interval");

    const tz = errors(spec("1.1", "    type: schedule\n    cron: 0 * * * *\n    tz: Mars/Base"));
    expect(tz[0]).toMatchObject({ path: ["agent", "trigger", "tz"], line: 10 });
    expect(tz[0]?.message).toContain("not a known IANA time zone");
  });

  it("refuses an unknown overlap and unknown fields", () => {
    expect(
      parseSpec(spec("1.1", "    type: schedule\n    every: 5m\n    overlap: both")).success,
    ).toBe(false);
    expect(
      parseSpec(spec("1.1", "    type: schedule\n    every: 5m\n    timezone: UTC")).success,
    ).toBe(false);
  });

  it("leaves webhook triggers unchanged", () => {
    expect(errors(spec("1.1", "    type: webhook\n    respond: sync"))).toEqual([]);
    expect(messages(spec("1.1", "    type: webhook\n    cron: '* * * * *'"))).toEqual([]);
  });
});

describe("published JSON Schema", () => {
  it("describes the schedule trigger", () => {
    const text = JSON.stringify(generateAgentSpecJsonSchema());
    expect(text).toContain('"const":"schedule"');
    expect(text).toContain('"overlap"');
  });
});

describe("schedule.ts copies", () => {
  it("the spec copy is byte-identical to the engine's (the vendorable source of truth)", () => {
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(read("../../src/schedule.ts")).toBe(read("../../../engine/src/schedule.ts"));
  });
});
