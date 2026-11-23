import { describe, expect, it } from "vitest";
import { groupFailures, type FailedItem } from "../../src/runErrors.js";

// KAM-298: 23 items that failed for one reason are one line and a count, with the odd one out beside them.

const NO_FIXTURE = (symbol: string) =>
  `Tool "kampong/alpha-vantage.time_series_daily" HTTP call to https://www.alphavantage.co/query?symbol=${symbol}&apikey=[REDACTED] failed: No recorded fixture for tool "kampong/alpha-vantage.time_series_daily" at /home/jian/projects/x/.try/demo/fixtures/kampong_alpha.${symbol}.json. Run once with tool mode "record" (after 3 attempts)`;
const item = (index: number, message: string, name = `T${index}`): FailedItem => ({
  loop: "each_symbol",
  index,
  step: "fetch",
  message,
  item: name,
});

describe("groupFailures", () => {
  it("groups by the plain reason, biggest first, so the dominant cause leads", () => {
    const items = [
      item(0, "HTTP 429 rate limit hit"),
      ...Array.from({ length: 22 }, (_, i) => item(i + 1, NO_FIXTURE(`Z${i}`))),
    ];
    const groups = groupFailures(items);
    expect(groups.map((g) => g.items.length)).toEqual([22, 1]);
    expect(groups[0]!.reason).toBe("This input has no recorded answer, so Replay cannot run it.");
    expect(groups[0]!.action).toMatch(/Run it live once/);
    expect(groups[1]!.reason).toMatch(/usage limit/);
  });

  it("keeps file paths and URLs out of a reason it does not recognise", () => {
    const [g] = groupFailures([
      item(
        0,
        "Widget exploded at /home/jian/projects/app/src/widget.ts while calling https://api.example.com/v1/things?key=abc",
      ),
    ]);
    expect(g!.reason).toBe("Widget exploded at … while calling …");
    expect(g!.reason).not.toContain("/home");
    expect(g!.reason).not.toContain("http");
  });

  it("cuts a very long unknown message short and never returns an empty reason", () => {
    const [long] = groupFailures([item(0, "x ".repeat(300))]);
    expect(long!.reason.length).toBeLessThanOrEqual(140);
    const [empty] = groupFailures([item(0, "")]);
    expect(empty!.reason).toBe("This step failed.");
  });
});
