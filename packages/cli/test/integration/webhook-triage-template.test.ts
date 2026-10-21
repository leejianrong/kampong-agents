import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSpec, specWarnings } from "@kampong/spec";
import { EXIT_SUCCESS, runCli } from "../../src/cli.js";
import { capture } from "../unit/test-helpers.js";

// KAM-217: the webhook-triage template, spec-only, runs offline on its recorded fixtures. Nothing here touches
// the network, Slack or a model: tool and model calls both replay. The full behaviour (a rejection, a webhook
// with its bearer check) is in e2e/webhook-triage-template.test.ts; this is the fast check that the shipped
// template and fixtures agree.

const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/webhook-triage/", import.meta.url));
const SPEC_PATH = `${TEMPLATE_DIR}agent.yaml`;
const FIXTURES = `${TEMPLATE_DIR}fixtures`;

const alert = (name: string, severity: string, summary: string) =>
  JSON.stringify({
    status: "firing",
    groupLabels: { alertname: name },
    alerts: [
      {
        status: "firing",
        labels: {
          alertname: name,
          severity,
          service: name === "DiskUsageHigh" ? "batch-runner" : "checkout",
        },
        annotations: { summary },
      },
    ],
  });
const CRITICAL = alert(
  "CheckoutErrorRate",
  "critical",
  "Checkout is failing 38% of payments since 09:14 UTC.",
);
const NOISY = alert(
  "DiskUsageHigh",
  "warning",
  "Disk usage is 78% and has been flapping around 75% all week.",
);

describe("the webhook-triage template", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("ALERT_WEBHOOK_TOKEN", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("the offline template test reached the network");
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const replay = async (input: string, ...extra: string[]) => {
    const { io, out, err } = capture();
    const code = await runCli(
      [
        "run",
        SPEC_PATH,
        "--input",
        input,
        "--json",
        "--tools",
        "replay",
        "--fixtures",
        FIXTURES,
        ...extra,
      ],
      io,
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("is a valid version 1.1 spec with an authenticated webhook trigger, no warnings and no literal secret", () => {
    const source = readFileSync(SPEC_PATH, "utf8");
    const parsed = parseSpec(source);
    expect(parsed.errors).toEqual([]);
    expect(specWarnings(parsed.spec!)).toEqual([]);
    expect(parsed.spec!.version).toBe("1.1");
    expect(parsed.spec!.agent.trigger).toMatchObject({
      type: "webhook",
      preset: "alertmanager",
      auth: { secret_env: "ALERT_WEBHOOK_TOKEN" },
    });
    expect(source).not.toMatch(/xoxb-/);
  });

  it("replays a critical alert: the model decides to post, the approval is answered, Slack is posted from its fixture", async () => {
    const { code, out, err } = await replay(CRITICAL, "--approve-all");
    expect(code, out + err).toBe(EXIT_SUCCESS);
    const outcome = JSON.parse(out) as { status: string; output: Record<string, unknown> };
    expect(outcome.status).toBe("completed");
    expect(outcome.output).toMatchObject({
      triage: { decision: "post", severity: "critical" },
      decide: { taken: "then" },
      review: { approved: true },
      post: { ok: true },
    });
  });

  it("replays a noisy alert: the model decides to skip, so no approval is asked and nothing is posted", async () => {
    const { code, out, err } = await replay(NOISY);
    expect(code, out + err).toBe(EXIT_SUCCESS);
    const outcome = JSON.parse(out) as {
      output: Record<string, unknown>;
      skipped?: { step: string };
    };
    expect(outcome.skipped).toMatchObject({ step: "quiet" });
    expect(outcome.output).not.toHaveProperty("review");
    expect(outcome.output).not.toHaveProperty("post");
  });

  it("a request with no alerts in it stops before the model is asked", async () => {
    const { code, out, err } = await replay("");
    expect(code, out + err).toBe(EXIT_SUCCESS);
    const outcome = JSON.parse(out) as {
      skipped?: { step: string };
      output: Record<string, unknown>;
    };
    expect(outcome.skipped).toMatchObject({ step: "no_alerts" });
    expect(outcome.output).not.toHaveProperty("triage");
  });

  it("an alert with no recorded model answer fails visibly instead of calling a model", async () => {
    const { code, out } = await replay(
      alert("SomethingElse", "critical", "Unrecorded."),
      "--approve-all",
    );
    expect(code).not.toBe(EXIT_SUCCESS);
    expect(out).toMatch(/recorded model fixture/i);
  });

  it("kampong doctor finds a recorded fixture for the Slack tool and the model call", async () => {
    const { io, out, err } = capture();
    const code = await runCli(
      ["doctor", SPEC_PATH, "--tools", "replay", "--fixtures", FIXTURES],
      io,
      { env: { SLACK_BOT_TOKEN: "k1" } },
    );
    expect(code, out.join("\n") + err.join("\n")).toBe(EXIT_SUCCESS);
    expect(out.join("\n")).toContain("tool post_to_slack has a recorded fixture");
  });
});
