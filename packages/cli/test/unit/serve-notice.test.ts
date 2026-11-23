import { describe, expect, it } from "vitest";
import { parseSpec } from "@kampong/spec";
import type { AgentSpec } from "@kampong/spec";
import {
  formatFindings,
  serveStartupFindings,
  serveTriggerLines,
  shownHost,
} from "../../src/serve-notice.js";

// KAM-308: the pieces of the serve start-up report.

const spec = (trigger: string, model = ""): AgentSpec => {
  const parsed = parseSpec(`version: "1.1"
agent:
  id: a
  name: "A"
  role: "r"
  goal: "g"
${model}${trigger}  workflow:
    - step: s
      type: transform
      set:
        v: "1"
`);
  if (!parsed.spec) throw new Error(JSON.stringify(parsed.errors));
  return parsed.spec as AgentSpec;
};

describe("shownHost", () => {
  it("never shows an every-interface address, and keeps a specific one", () => {
    expect(shownHost("0.0.0.0")).toBe("localhost");
    expect(shownHost("::")).toBe("localhost");
    expect(shownHost("10.0.0.7")).toBe("10.0.0.7");
  });
});

describe("serveTriggerLines", () => {
  const at = (iso: string) => () => Date.parse(iso);

  it("a webhook shows a pasteable URL and a note about reaching it from elsewhere", () => {
    const lines = serveTriggerLines(spec("  trigger:\n    type: webhook\n"), {
      host: "0.0.0.0",
      port: 8080,
    });
    expect(lines[0]).toBe("  trigger: POST http://localhost:8080/webhook");
    expect(lines.join("\n")).toMatch(/another machine/);
  });

  it("a schedule says when it first runs, not 'POST /webhook'", () => {
    const lines = serveTriggerLines(spec("  trigger:\n    type: schedule\n    every: 6h\n"), {
      host: "127.0.0.1",
      port: 8080,
      now: at("2026-11-23T00:00:00Z"),
    });
    expect(lines[0]).toMatch(
      /^ {2}trigger: schedule, every 6h; the first run is at \d{4}-\d\d-\d\d \d\d:\d\d/,
    );
    expect(lines.join("\n")).not.toContain("/webhook");
    expect(lines).toContain("  run now: POST http://127.0.0.1:8080/schedule/run-now");
  });

  it("a cron schedule names its time zone", () => {
    const lines = serveTriggerLines(
      spec('  trigger:\n    type: schedule\n    cron: "0 9 * * *"\n    tz: Asia/Singapore\n'),
      { host: "127.0.0.1", port: 1, now: at("2026-11-23T00:00:00Z") },
    );
    expect(lines[0]).toContain("cron 0 9 * * * (Asia/Singapore)");
  });
});

describe("serveStartupFindings", () => {
  const ollama = "  model:\n    provider: ollama\n    name: m\n";

  it("reports an unreachable local model and stays quiet when it answers", async () => {
    const s = spec("", ollama);
    const down = await serveStartupFindings(s, "/nowhere/agent.yaml", {
      env: {},
      connect: async () => "connect ECONNREFUSED",
    });
    expect(down.join("\n")).toMatch(/Ollama\) is not reachable at localhost:11434/);
    const up = await serveStartupFindings(s, "/nowhere/agent.yaml", {
      env: {},
      connect: async () => undefined,
    });
    expect(up.join("\n")).not.toMatch(/not reachable/);
  });

  it("reports an unset webhook secret by name only", async () => {
    const s = spec(
      "  trigger:\n    type: webhook\n    auth:\n      type: bearer\n      secret_env: HOOK_TOKEN\n",
      ollama,
    );
    const set = await serveStartupFindings(s, "/nowhere/agent.yaml", {
      env: { HOOK_TOKEN: "super-secret-value" },
      connect: async () => undefined,
    });
    expect(set.join("\n")).not.toContain("HOOK_TOKEN");
    const unset = await serveStartupFindings(s, "/nowhere/agent.yaml", {
      env: {},
      connect: async () => undefined,
    });
    expect(unset.join("\n")).toContain("HOOK_TOKEN is not set");
    expect(set.join("\n") + unset.join("\n")).not.toContain("super-secret-value");
  });
});

describe("formatFindings", () => {
  it("says nothing when nothing is wrong, and counts what is", () => {
    expect(formatFindings([])).toEqual([]);
    expect(formatFindings(["a", "b"])[0]).toMatch(/2 things to fix/);
    expect(formatFindings(["a"])[0]).toMatch(/1 thing to fix/);
  });
});
