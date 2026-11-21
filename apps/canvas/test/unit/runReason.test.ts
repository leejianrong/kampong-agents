import { describe, expect, it } from "vitest";
import { explainError, trimUrls } from "../../src/runReason.js";
import { isEmptyData } from "../../src/DataFields.js";
import { nextRow, nextTab } from "../../src/tabKeys.js";

// KAM-270: a failed step in words a person can act on. KAM-271: empty input is not shown. KAM-277: tab keys.

const ALPHA =
  'Tool "kampong/alpha-vantage.time_series_daily" HTTP call to https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=MSFT&apikey=[REDACTED] reported a failure: Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day.';

describe("explainError", () => {
  it("reads a rate limit as a headline and a next step, naming the service", () => {
    const r = explainError(ALPHA);
    expect(r.headline).toBe("Alpha Vantage's usage limit was reached.");
    expect(r.action).toContain("Wait");
    expect(r.known).toBe(true);
  });

  it("names a missing key and says where to set it", () => {
    const r = explainError("ALPHAVANTAGE_API_KEY is not set");
    expect(r.headline).toContain("ALPHAVANTAGE_API_KEY");
    expect(r.action).toContain("Secrets");
  });

  it.each([
    ["HTTP 401 Unauthorized", "did not accept the key"],
    ["HTTP 404 not found", "could not find"],
    ["The operation timed out", "took too long"],
    ["HTTP 503 service unavailable", "problem on its side"],
    ["fetch failed", "Could not reach"],
  ])("reads %j", (message, words) => {
    expect(explainError(message).headline).toContain(words);
  });

  it("falls back to a plain line and says it is not a known kind", () => {
    expect(explainError("something odd")).toEqual({ headline: "This step failed.", known: false });
  });
});

describe("explainError: a Replay with no recording (KAM-281)", () => {
  const MODEL =
    "No recorded model fixture at fixtures/@model.summarise.7f3a.json for summarise. Run once with `--tools record` (or `--model record`) against a live model to create it. A replay never falls back to a live call.";
  const TOOL =
    'No recorded fixture for tool "fetch" at fixtures/fetch.json. Run once with tool mode record to create it.';

  it.each([MODEL, TOOL])(
    "says it in plain words, with no flags or paths, and offers the fix",
    (m) => {
      const r = explainError(m);
      expect(r.known).toBe(true);
      expect(r.fix).toBe("replay_missing");
      expect(r.headline).toBe("This input has no recorded answer, so Replay cannot run it.");
      expect(r.action).toMatch(/live|clear/i);
      expect(`${r.headline} ${r.action}`).not.toMatch(/--|fixtures\/|\.json|@model/);
    },
  );
});

describe("trimUrls", () => {
  it("cuts a URL's query string, where a key or a long filter sits", () => {
    expect(trimUrls(ALPHA)).toContain("https://www.alphavantage.co/query?…");
    expect(trimUrls(ALPHA)).not.toContain("apikey");
  });
});

describe("isEmptyData", () => {
  it("treats the run's empty input as nothing to show", () => {
    expect(isEmptyData({ input: "" })).toBe(true);
    expect(isEmptyData({ input: "", fetch: undefined })).toBe(true);
    expect(isEmptyData({ input: "hello" })).toBe(false);
    expect(isEmptyData({ rows: [1] })).toBe(false);
  });
});

describe("tab keys", () => {
  const ids = ["input", "output", "error"] as const;
  it("moves with the arrows, wraps, and jumps with Home and End", () => {
    expect(nextTab("ArrowRight", ids, "input")).toBe("output");
    expect(nextTab("ArrowRight", ids, "error")).toBe("input");
    expect(nextTab("ArrowLeft", ids, "input")).toBe("error");
    expect(nextTab("Home", ids, "error")).toBe("input");
    expect(nextTab("End", ids, "input")).toBe("error");
    expect(nextTab("x", ids, "input")).toBeUndefined();
  });
  it("moves a row at a time and stops at the ends", () => {
    expect(nextRow("ArrowDown", 3, 0)).toBe(1);
    expect(nextRow("ArrowDown", 3, 2)).toBe(2);
    expect(nextRow("ArrowUp", 3, 0)).toBe(0);
    expect(nextRow("Home", 3, 2)).toBe(0);
    expect(nextRow("End", 3, 0)).toBe(2);
    expect(nextRow("ArrowDown", 0, 0)).toBeUndefined();
  });
});
