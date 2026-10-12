import { describe, expect, it } from "vitest";
import {
  buildSchedule,
  isValidTimeZone,
  nextCronRun,
  nextTick,
  parseCron,
  parseEvery,
} from "../../src/schedule.js";

// KAN-1856: cron/every parsing and next-tick computation, including daylight saving transitions. Every
// test passes the "current time" explicitly, so none depends on the wall clock.

const cron = (expr: string) => {
  const r = parseCron(expr);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const next = (expr: string, tz: string, after: string) =>
  iso(nextCronRun(cron(expr), tz, Date.parse(after)));

describe("parseCron", () => {
  it("accepts lists, ranges, steps, names and 7 as Sunday", () => {
    expect(parseCron("*/15 9-17 * jan-mar mon-fri").ok).toBe(true);
    expect(parseCron("0,30 0 1 JAN,dec sun").ok).toBe(true);
    expect([...cron("0 0 * * 7").dow]).toEqual([0]);
    expect([...cron("10/20 * * * *").minute]).toEqual([10, 30, 50]);
  });

  it.each([
    ["", "5 fields"],
    ["* * * *", "5 fields"],
    ["* * * * * *", "5 fields"],
    ["60 * * * *", "minute value 60 is out of range 0-59"],
    ["* 24 * * *", "hour value 24"],
    ["* * 0 * *", "day-of-month value 0"],
    ["* * * 13 *", "month value 13"],
    ["* * * * 8", "day-of-week value 8"],
    ["*/0 * * * *", "step"],
    ["5-1 * * * *", "runs backwards"],
    ["a * * * *", 'unrecognised value "a"'],
    ["* * 30 2 *", "never matches a real date"],
  ])("rejects %j", (expr, fragment) => {
    const r = parseCron(expr);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(fragment);
  });
});

describe("parseEvery", () => {
  it("reads seconds, minutes, hours and days", () => {
    expect(parseEvery("30s")).toEqual({ ok: true, value: 30_000 });
    expect(parseEvery("15m")).toEqual({ ok: true, value: 900_000 });
    expect(parseEvery("6h")).toEqual({ ok: true, value: 21_600_000 });
    expect(parseEvery("1d")).toEqual({ ok: true, value: 86_400_000 });
  });
  it.each(["", "5", "m", "0s", "1.5h", "-5m", "5 weeks"])("rejects %j", (text) => {
    expect(parseEvery(text).ok).toBe(false);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names and rejects the rest", () => {
    expect(isValidTimeZone("Asia/Singapore")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(" UTC")).toBe(false);
  });
});

describe("buildSchedule", () => {
  it("needs exactly one of cron or every, and tz only with cron", () => {
    expect(buildSchedule({})).toEqual({ ok: false, error: "set exactly one of cron or every" });
    expect(buildSchedule({ cron: "* * * * *", every: "5m" }).ok).toBe(false);
    expect(buildSchedule({ every: "5m", tz: "UTC" })).toEqual({
      ok: false,
      error: "tz only applies to cron",
    });
  });
  it("defaults the zone to UTC and names a bad zone", () => {
    const ok = buildSchedule({ cron: "0 3 * * *" });
    expect(ok.ok && ok.value.kind === "cron" && ok.value.tz).toBe("UTC");
    const bad = buildSchedule({ cron: "0 3 * * *", tz: "Nowhere/Land" });
    expect(!bad.ok && bad.error).toContain("not a known IANA time zone");
  });
});

describe("nextCronRun", () => {
  it("finds the next minute, day, month and year boundaries", () => {
    expect(next("*/15 * * * *", "UTC", "2025-06-01T10:07:30Z")).toBe("2025-06-01T10:15:00.000Z");
    expect(next("0 9 * * *", "UTC", "2025-06-01T09:00:00Z")).toBe("2025-06-02T09:00:00.000Z");
    expect(next("0 0 1 1 *", "UTC", "2025-06-01T00:00:00Z")).toBe("2026-01-01T00:00:00.000Z");
    expect(next("0 0 29 2 *", "UTC", "2025-01-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
  });

  it("is strictly after the given instant", () => {
    expect(next("0 * * * *", "UTC", "2025-06-01T10:00:00Z")).toBe("2025-06-01T11:00:00.000Z");
  });

  it("reads the expression in the given zone", () => {
    // 09:00 in Singapore (UTC+8, no DST) is 01:00Z.
    expect(next("0 9 * * *", "Asia/Singapore", "2025-06-01T00:00:00Z")).toBe(
      "2025-06-01T01:00:00.000Z",
    );
    // 09:00 in New York in June is EDT (UTC-4).
    expect(next("0 9 * * *", "America/New_York", "2025-06-01T00:00:00Z")).toBe(
      "2025-06-01T13:00:00.000Z",
    );
  });

  it("matches day-of-month OR day-of-week when both are restricted", () => {
    // The 13th, or any Friday. 2025-06-01 is a Sunday: next Friday is the 6th.
    expect(next("0 0 13 * 5", "UTC", "2025-06-01T00:00:00Z")).toBe("2025-06-06T00:00:00.000Z");
    expect(next("0 0 13 * 5", "UTC", "2025-06-07T00:00:00Z")).toBe("2025-06-13T00:00:00.000Z");
  });

  describe("spring forward (America/New_York, 2025-03-09: 02:00 EST -> 03:00 EDT)", () => {
    it("fires a time inside the gap once, at the first instant after it", () => {
      // 02:30 does not exist that day; the job runs at 03:00 EDT = 07:00Z.
      expect(next("30 2 * * *", "America/New_York", "2025-03-09T00:00:00Z")).toBe(
        "2025-03-09T07:00:00.000Z",
      );
      // ...and the next day is back to 02:30 EDT = 06:30Z.
      expect(next("30 2 * * *", "America/New_York", "2025-03-09T07:00:00Z")).toBe(
        "2025-03-10T06:30:00.000Z",
      );
    });

    it("does not double-fire when several matches fall in the gap", () => {
      const c = cron("*/15 * * * *");
      const fires: string[] = [];
      let t = Date.parse("2025-03-09T06:30:00Z"); // 01:30 EST
      for (let i = 0; i < 6; i++) {
        t = nextCronRun(c, "America/New_York", t)!;
        fires.push(new Date(t).toISOString());
      }
      expect(fires).toEqual([
        "2025-03-09T06:45:00.000Z", // 01:45 EST
        "2025-03-09T07:00:00.000Z", // 03:00 EDT (02:00-02:45 collapse into it)
        "2025-03-09T07:15:00.000Z",
        "2025-03-09T07:30:00.000Z",
        "2025-03-09T07:45:00.000Z",
        "2025-03-09T08:00:00.000Z",
      ]);
    });

    it("leaves times outside the gap alone", () => {
      expect(next("0 3 * * *", "America/New_York", "2025-03-09T00:00:00Z")).toBe(
        "2025-03-09T07:00:00.000Z",
      );
    });
  });

  describe("fall back (America/New_York, 2025-11-02: 02:00 EDT -> 01:00 EST)", () => {
    it("fires a repeated time once, at its first occurrence", () => {
      // 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST).
      expect(next("30 1 * * *", "America/New_York", "2025-11-02T00:00:00Z")).toBe(
        "2025-11-02T05:30:00.000Z",
      );
      // After the first occurrence the next run is the following day (06:30Z is the same wall time).
      expect(next("30 1 * * *", "America/New_York", "2025-11-02T05:30:00Z")).toBe(
        "2025-11-03T06:30:00.000Z",
      );
    });

    it("keeps a daily job at its wall-clock time across the change", () => {
      expect(next("0 9 * * *", "America/New_York", "2025-11-01T14:00:00Z")).toBe(
        "2025-11-02T14:00:00.000Z", // 09:00 EST, one hour later in UTC than the day before
      );
    });

    it("does not skip or repeat any later time after the repeated hour", () => {
      const c = cron("0 * * * *");
      let t = Date.parse("2025-11-02T04:30:00Z"); // 00:30 EDT
      const fires: string[] = [];
      for (let i = 0; i < 4; i++) {
        t = nextCronRun(c, "America/New_York", t)!;
        fires.push(new Date(t).toISOString());
      }
      expect(fires).toEqual([
        "2025-11-02T05:00:00.000Z", // 01:00 EDT
        "2025-11-02T07:00:00.000Z", // 02:00 EST (the second 01:00 is the same wall time: fires once)
        "2025-11-02T08:00:00.000Z",
        "2025-11-02T09:00:00.000Z",
      ]);
    });
  });

  it("handles a zone ahead of UTC with a gap at a different hour (Europe/London, 2025-03-30)", () => {
    // 01:30 does not exist (01:00 GMT -> 02:00 BST): runs at 02:00 BST = 01:00Z.
    expect(next("30 1 * * *", "Europe/London", "2025-03-30T00:00:00Z")).toBe(
      "2025-03-30T01:00:00.000Z",
    );
  });

  it("handles a half-hour DST shift (Australia/Lord_Howe, 2025-10-05: 02:00 -> 02:30)", () => {
    // 02:15 does not exist; the job runs at 02:30 local (+11:00) = 15:30Z the day before.
    expect(next("15 2 * * *", "Australia/Lord_Howe", "2025-10-04T00:00:00Z")).toBe(
      "2025-10-04T15:30:00.000Z",
    );
  });
});

describe("nextTick for every", () => {
  it("ticks on the interval from an anchor, regardless of when it is asked", () => {
    const s = buildSchedule({ every: "10m" });
    if (!s.ok) throw new Error(s.error);
    expect(nextTick(s.value, 0, 0)).toBe(600_000);
    expect(nextTick(s.value, 599_999, 0)).toBe(600_000);
    expect(nextTick(s.value, 600_000, 0)).toBe(1_200_000);
    expect(nextTick(s.value, 1_000_000, 100_000)).toBe(1_300_000 - 0);
  });

  it("counts elapsed time across a DST change (no calendar involved)", () => {
    const s = buildSchedule({ every: "1d" });
    if (!s.ok) throw new Error(s.error);
    const start = Date.parse("2025-03-08T12:00:00Z");
    expect(iso(nextTick(s.value, start, start))).toBe("2025-03-09T12:00:00.000Z");
    expect(iso(nextTick(s.value, Date.parse("2025-03-09T12:00:00Z"), start))).toBe(
      "2025-03-10T12:00:00.000Z",
    );
  });
});
