import { describe, expect, it } from "vitest";
import { describeCron, previewSchedule } from "../../src/schedule-preview.js";
import { parseCron } from "../../src/schedule.js";

// KAM-197: what the Trigger form says about a schedule while it is typed: words, the next three runs, a warning.

// Wednesday 2026-10-21 10:30:00 UTC
const NOW = Date.UTC(2026, 9, 21, 10, 30, 0);

const words = (cron: string) => {
  const parsed = parseCron(cron);
  if (!parsed.ok) throw new Error(parsed.error);
  return describeCron(parsed.value);
};

describe("describeCron", () => {
  it.each([
    ["* * * * *", "every minute"],
    ["*/5 * * * *", "every 5 minutes"],
    ["*/15 * * * *", "every 15 minutes"],
    ["30 * * * *", "at minute 30 of every hour"],
    ["0 9 * * *", "at 09:00 every day"],
    ["30 18 * * 1-5", "at 18:30 on weekdays"],
    ["0 8 * * 6,0", "at 08:00 on weekends"],
    ["0 9 * * mon,wed", "at 09:00 on Monday, Wednesday"],
    ["0 9,17 * * *", "at 09:00, 17:00 every day"],
  ])("reads %s as %j", (cron, expected) => {
    expect(words(cron)).toBe(expected);
  });

  it("gives up, rather than guess, on a shape with no short reading", () => {
    expect(words("0 9 1 * *")).toBeUndefined();
    expect(words("0 9 * 6 *")).toBeUndefined();
    expect(words("7,13,41 * * * *")).toBeUndefined();
  });
});

describe("previewSchedule", () => {
  it("previews the next three runs of a cron, in its time zone, with the words for it", () => {
    const result = previewSchedule({ cron: "0 9 * * *", tz: "Asia/Singapore" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.description).toBe("at 09:00 every day");
    expect(result.preview.timeZone).toBe("Asia/Singapore");
    // 09:00 in Singapore (UTC+8) is 01:00 UTC; the next is tomorrow, then the day after.
    expect(result.preview.runs).toEqual([
      Date.UTC(2026, 9, 22, 1, 0),
      Date.UTC(2026, 9, 23, 1, 0),
      Date.UTC(2026, 9, 24, 1, 0),
    ]);
    expect(result.preview.warning).toBeUndefined();
  });

  it("defaults the time zone to UTC", () => {
    const result = previewSchedule({ cron: "0 12 * * *" }, NOW);
    expect(result.ok && result.preview.timeZone).toBe("UTC");
    expect(result.ok && result.preview.runs[0]).toBe(Date.UTC(2026, 9, 21, 12, 0));
  });

  it("warns on a cron that runs every minute, not on one that runs every five", () => {
    const every = previewSchedule({ cron: "* * * * *" }, NOW);
    expect(every.ok && every.preview.warning).toMatch(/runs every minute/);
    expect(every.ok && every.preview.runs).toHaveLength(3);
    const five = previewSchedule({ cron: "*/5 * * * *" }, NOW);
    expect(five.ok && five.preview.warning).toBeUndefined();
  });

  it("warns on an interval under a minute, and says how often", () => {
    const ten = previewSchedule({ every: "10s" }, NOW);
    expect(ten.ok && ten.preview.warning).toMatch(/every 10 seconds, more than once a minute/);
    const one = previewSchedule({ every: "1s" }, NOW);
    expect(one.ok && one.preview.warning).toMatch(/every 1 second,/);
    for (const calm of ["1m", "30m", "2h", "1d"]) {
      const result = previewSchedule({ every: calm }, NOW);
      expect(result.ok && result.preview.warning, calm).toBeUndefined();
    }
  });

  it("counts an interval's next runs from now, with no time zone", () => {
    const result = previewSchedule({ every: "15m" }, NOW);
    expect(result.ok && result.preview.timeZone).toBeNull();
    expect(result.ok && result.preview.intervalMs).toBe(900_000);
    expect(result.ok && result.preview.runs).toEqual([
      NOW + 900_000,
      NOW + 1_800_000,
      NOW + 2_700_000,
    ]);
  });

  it("says what is wrong in the validator's own words, so the save would say the same", () => {
    expect(previewSchedule({ cron: "* * *" }, NOW)).toEqual({
      ok: false,
      error: expect.stringContaining("5 fields"),
    });
    expect(previewSchedule({ cron: "0 9 * * *", tz: "Mars/Olympus" }, NOW)).toEqual({
      ok: false,
      error: expect.stringContaining("IANA time zone"),
    });
    expect(previewSchedule({ every: "soon" }, NOW)).toEqual({
      ok: false,
      error: expect.stringContaining("not an interval"),
    });
    expect(previewSchedule({ cron: "0 0 30 2 *" }, NOW)).toEqual({
      ok: false,
      error: expect.stringContaining("never matches"),
    });
  });
});
