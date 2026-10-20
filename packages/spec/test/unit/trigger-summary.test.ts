import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/parse.js";
import { specToGraph } from "../../src/graph.js";
import { triggerSummary } from "../../src/trigger-summary.js";

// KAM-184: the trigger node says what starts a run, by type.

describe("triggerSummary", () => {
  it("reads Manual when there is no trigger", () => {
    expect(triggerSummary(undefined)).toBe("Manual");
  });
  it("names a schedule by its interval or its cron", () => {
    expect(triggerSummary({ type: "schedule", every: "6h" })).toBe("Schedule: every 6h");
    expect(triggerSummary({ type: "schedule", cron: "0 9 * * 1-5", tz: "Asia/Singapore" })).toBe(
      "Schedule: cron 0 9 * * 1-5 Asia/Singapore",
    );
    expect(triggerSummary({ type: "schedule", cron: "0 9 * * *" })).toBe(
      "Schedule: cron 0 9 * * *",
    );
  });
  it("names a webhook by its preset, else its auth", () => {
    expect(triggerSummary({ type: "webhook", preset: "github" })).toBe("Webhook (GitHub)");
    expect(triggerSummary({ type: "webhook", preset: "alertmanager" })).toBe(
      "Webhook (Alertmanager)",
    );
    expect(triggerSummary({ type: "webhook" })).toBe("Webhook");
    expect(triggerSummary({ type: "webhook", auth: "none" })).toBe("Webhook (no auth)");
    expect(triggerSummary({ type: "webhook", auth: { type: "hmac", secret_env: "S" } })).toBe(
      "Webhook (HMAC)",
    );
    expect(triggerSummary({ type: "webhook", auth: { type: "bearer", secret_env: "S" } })).toBe(
      "Webhook (bearer)",
    );
  });
  it("names a poll by its interval", () => {
    expect(
      triggerSummary({
        type: "poll",
        every: "5m",
        use: "kampong/gmail-imap@1.0.0",
        op: "list_unseen",
        id: "uid",
        dedupe: "greatest",
      } as never),
    ).toBe("Poll: every 5m");
  });
});

describe("the agent node of the graph", () => {
  const source = (trigger: string, version = "1.0") => `version: "${version}"
agent:
  id: a
  name: Market ETL
  role: R
  goal: G
${trigger}  workflow:
    - step: s
      action: write
`;
  const label = (yaml: string) => {
    const parsed = parseSpec(yaml);
    if (!parsed.spec) throw new Error(JSON.stringify(parsed.errors));
    return specToGraph(parsed.spec).nodes[0]!.data.triggerLabel;
  };
  it("carries Manual for a 1.0 spec with no trigger", () => {
    expect(label(source(""))).toBe("Manual");
  });
  it("carries the schedule", () => {
    expect(label(source("  trigger:\n    type: schedule\n    every: 6h\n", "1.1"))).toBe(
      "Schedule: every 6h",
    );
  });
});
