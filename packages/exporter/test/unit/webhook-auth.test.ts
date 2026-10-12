import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSpec, type AgentSpec } from "@kampong/spec";
import { collectRequiredEnvVars, exportProject } from "../../src/index.js";

// KAN-1848 (ADR-0047): an export of a webhook with auth presets, `when` and `map` carries the verification
// into its generated server, names the secret variable, and documents it. The behavior itself is the vendored
// engine code (runtime-parity.test.ts) and is run for real in e2e/exporter-behavioral-equivalence.test.ts.

const SOURCE = `version: "1.1"
agent:
  id: hook
  name: "Hook"
  role: "Handler"
  goal: "Handle an event."
  trigger:
    type: webhook
    preset: slack
    auth:
      secret_env: SLACK_APP_SECRET
    when: trigger.type = "event_callback"
    map:
      text: trigger.event.text
  workflow:
    - step: handle
      action: answer_question
      query: "{{ trigger.text }}"
`;

describe("export of a webhook with auth", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-export-auth-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const spec = () => {
    const parsed = parseSpec(SOURCE);
    expect(parsed.errors).toEqual([]);
    return parsed.spec as AgentSpec;
  };

  it("lists the secret variable, and nothing else, as required", () => {
    expect(collectRequiredEnvVars(spec())).toEqual(["SLACK_APP_SECRET"]);
  });

  it("generates a server that verifies against the raw body before anything runs", () => {
    exportProject(spec(), dir);
    const server = readFileSync(join(dir, "src", "server.ts"), "utf8");
    expect(server).toContain('from "./runtime/webhook-trigger.js"');
    expect(server).toContain("handleWebhookRequest(trigger");
    expect(server).toContain("rawBody");
    expect(server).toContain('decision.action === "ignore"');
    expect(server).not.toContain("const CREDENTIAL_HEADER");
    // The baked spec holds the secret's variable name, never a value.
    expect(server).toContain('"secret_env": "SLACK_APP_SECRET"');
  });

  it("vendors the verification code and documents it in the README", () => {
    exportProject(spec(), dir);
    expect(readFileSync(join(dir, "src", "runtime", "webhook-auth.ts"), "utf8")).toContain(
      "resolveWebhookAuth",
    );
    for (const f of ["webhook-trigger.ts"]) {
      expect(readFileSync(join(dir, "src", "runtime", f), "utf8")).toContain("timingSafeEqual");
    }
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("Webhook authentication and filtering");
    expect(readme).toContain("`x-slack-signature`");
    expect(readme).toContain("SLACK_APP_SECRET");
    expect(readme).toContain("url_verification");
    expect(readme).toContain("/triggers/ignored");
  });

  it("a webhook without auth adds no section and no variable", () => {
    const plain = parseSpec(SOURCE.replace(/ {4}preset[\s\S]* {6}text: trigger.event.text\n/, ""));
    expect(plain.errors).toEqual([]);
    exportProject(plain.spec as AgentSpec, dir);
    expect(readFileSync(join(dir, "README.md"), "utf8")).not.toContain(
      "Webhook authentication and filtering",
    );
  });
});
