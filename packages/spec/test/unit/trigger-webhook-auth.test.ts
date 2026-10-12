import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { resolveWebhookAuth, secretEnvName } from "../../src/webhook-auth.js";

// KAN-1848 (ADR-0047): webhook auth presets, `when` and `map`.

const spec = (version: string, trigger: string) => `version: "${version}"
agent:
  id: a
  name: A
  role: R
  goal: G
  trigger:
    type: webhook
${trigger}
  workflow:
    - step: s
      action: write
`;
const errorsOf = (source: string) => parseSpec(source).errors;
const messages = (source: string) => errorsOf(source).map((e) => e.message);

describe("webhook auth in the spec", () => {
  it("accepts each preset with a secret_env and round-trips", () => {
    for (const preset of ["github", "slack", "alertmanager", "generic"]) {
      const source = spec("1.1", `    preset: ${preset}\n    auth:\n      secret_env: HOOK_SECRET`);
      const result = parseSpec(source);
      expect(result.errors, preset).toEqual([]);
      expect(toYamlString(result.doc)).toBe(source);
    }
  });

  it("accepts explicit none, bearer and hmac", () => {
    expect(messages(spec("1.1", "    auth: none"))).toEqual([]);
    expect(messages(spec("1.1", "    auth:\n      type: none"))).toEqual([]);
    expect(messages(spec("1.1", "    auth:\n      type: bearer\n      secret_env: TOKEN"))).toEqual(
      [],
    );
    expect(
      messages(
        spec(
          "1.1",
          "    auth:\n      type: hmac\n      header: X-Sig\n      algo: sha1\n      encoding: base64\n      secret_env: ${SIG_SECRET}",
        ),
      ),
    ).toEqual([]);
  });

  it("needs version 1.1", () => {
    for (const field of [
      "preset: github",
      "auth: none",
      "when: trigger.x",
      "map:\n      a: trigger.x",
    ]) {
      expect(messages(spec("1.0", `    ${field}`)).join("|")).toContain('needs version "1.1"');
    }
  });

  it("refuses a literal secret without repeating it, and points at the line", () => {
    const source = spec(
      "1.1",
      "    auth:\n      type: bearer\n      secret_env: s3cr3t-literal-value",
    );
    const errors = errorsOf(source);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("NAME of an environment variable");
    expect(errors[0]!.message).not.toContain("s3cr3t");
    expect(errors[0]!.line).toBe(11);
  });

  it("says what a preset or type is missing", () => {
    expect(messages(spec("1.1", "    preset: github"))).toEqual([
      expect.stringContaining("preset github needs auth.secret_env"),
    ]);
    expect(messages(spec("1.1", "    auth:\n      secret_env: X"))).toEqual([
      expect.stringContaining("auth needs a type"),
    ]);
    expect(messages(spec("1.1", "    auth:\n      type: hmac\n      secret_env: X"))).toEqual([
      expect.stringContaining("needs header"),
    ]);
    expect(
      messages(spec("1.1", "    auth:\n      type: bearer\n      secret_env: X\n      header: h")),
    ).toEqual([expect.stringContaining("only applies to auth")]);
  });

  it("refuses conflicts with a preset and a window without a timestamp", () => {
    expect(
      messages(
        spec("1.1", "    preset: slack\n    auth:\n      type: bearer\n      secret_env: X"),
      ),
    ).toEqual([expect.stringContaining("does not match")]);
    expect(messages(spec("1.1", "    preset: github\n    auth: none"))).toEqual([
      expect.stringContaining('cannot be "none"'),
    ]);
    expect(
      messages(
        spec(
          "1.1",
          "    auth:\n      type: hmac\n      header: x\n      secret_env: X\n      window_s: 60",
        ),
      ),
    ).toEqual([expect.stringContaining("window_s needs timestamp_header")]);
  });

  it("refuses unknown auth keys and presets", () => {
    expect(parseSpec(spec("1.1", "    auth:\n      type: bearer\n      secret: x")).success).toBe(
      false,
    );
    expect(parseSpec(spec("1.1", "    preset: stripe")).success).toBe(false);
  });
});

describe("webhook when and map", () => {
  it("accept expressions over trigger and round-trip", () => {
    const source = spec(
      "1.1",
      '    when: trigger.headers.`x-github-event` = "push"\n    map:\n      repo: trigger.repository.full_name\n      sha: trigger.after',
    );
    const result = parseSpec(source);
    expect(result.errors).toEqual([]);
    expect(toYamlString(result.doc)).toBe(source);
  });

  it("reports a syntax error with its line", () => {
    const errors = errorsOf(spec("1.1", "    when: trigger.a ="));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.line).toBe(9);
  });

  it("refuses names other than trigger, and map keys headers/body", () => {
    expect(messages(spec("1.1", "    when: vars.x = 1"))[0]).toContain(
      "not available when a request",
    );
    expect(messages(spec("1.1", "    map:\n      a: input"))[0]).toContain("map.a");
    expect(messages(spec("1.1", "    map:\n      headers: trigger.x"))[0]).toContain(
      'cannot set "headers"',
    );
  });
});

describe("resolveWebhookAuth", () => {
  it("expands github", () => {
    expect(resolveWebhookAuth("github", { secret_env: "${GH}" })).toEqual({
      ok: true,
      auth: {
        type: "hmac",
        secretEnv: "GH",
        header: "x-hub-signature-256",
        algo: "sha256",
        prefix: "sha256=",
        encoding: "hex",
        payload: "{body}",
      },
    });
  });
  it("expands slack with a timestamp window and the v0 base string", () => {
    const r = resolveWebhookAuth("slack", { secret_env: "S" });
    expect(r.ok && r.auth).toMatchObject({
      header: "x-slack-signature",
      prefix: "v0=",
      timestampHeader: "x-slack-request-timestamp",
      windowS: 300,
      payload: "v0:{timestamp}:{body}",
    });
  });
  it("expands alertmanager to bearer and lets auth override preset fields", () => {
    expect(resolveWebhookAuth("alertmanager", { secret_env: "T" })).toEqual({
      ok: true,
      auth: { type: "bearer", secretEnv: "T", header: "authorization" },
    });
    const r = resolveWebhookAuth("slack", { secret_env: "S", window_s: 60 });
    expect(r.ok && r.auth).toMatchObject({ windowS: 60 });
  });
  it("shapes env names", () => {
    expect(secretEnvName("${A_1}")).toBe("A_1");
    expect(secretEnvName("lowercase")).toBeUndefined();
    expect(secretEnvName("has space")).toBeUndefined();
  });
});

describe("webhook-auth.ts copies", () => {
  it("the spec copy is byte-identical to the engine's", () => {
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(read("../../src/webhook-auth.ts")).toBe(read("../../../engine/src/webhook-auth.ts"));
  });
});
