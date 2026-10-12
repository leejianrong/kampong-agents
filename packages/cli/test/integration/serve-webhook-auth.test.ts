import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@kampong/engine";
import { createServeServer } from "../../src/serve-server.js";

// KAN-1848 (ADR-0047): webhook auth presets, `when` and `map` through `kampong serve`. Signed bodies are
// computed here with a fixed clock; the fixtures are shared with the engine's unit tests.

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../engine/test/fixtures/webhooks/${name}`, import.meta.url)),
    "utf8",
  );
const NOW_S = 1_700_000_000;
const env = { GH_SECRET: "gh-secret", SLACK_SECRET: "sl-secret", AM_TOKEN: "am-token" };
const sign = (secret: string, data: string) =>
  createHmac("sha256", secret).update(data).digest("hex");

const spec = (trigger: string) => `version: "1.1"
agent:
  id: hook
  name: "Hook"
  role: "Handler"
  goal: "Handle an event."
  trigger:
    type: webhook
${trigger}
  workflow:
    - step: handle
      action: answer_question
      query: "{{ trigger.repo }}"
`;

describe("kampong serve: webhook auth, when and map", () => {
  let dir: string;
  let app: FastifyInstance | undefined;
  let prompts: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-serve-auth-"));
    prompts = [];
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function serve(trigger: string) {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, spec(trigger));
    const model: ModelClient = {
      async generateText(input) {
        prompts.push(input.prompt);
        return "done";
      },
      async generateStructured<T>() {
        return {} as T;
      },
    };
    app = createServeServer({
      specPath,
      now: () => NOW_S * 1000,
      run: { createModel: () => model, env: { ...env } },
    });
    return app;
  }
  const post = (
    a: FastifyInstance,
    payload: string,
    headers: Record<string, string> = {},
    url = "/webhook",
  ) =>
    a.inject({
      method: "POST",
      url,
      payload,
      headers: { "content-type": "application/json", ...headers },
    });

  const GITHUB = "    preset: github\n    auth:\n      secret_env: GH_SECRET";

  it("github: a signed push starts a run (201), a tampered one is 401 and starts none", async () => {
    const a = serve(GITHUB);
    const body = fixture("push-event.json");
    const ok = await post(a, body, { "x-hub-signature-256": `sha256=${sign("gh-secret", body)}` });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().id).toEqual(expect.any(String));

    const bad = await post(a, body + " ", {
      "x-hub-signature-256": `sha256=${sign("gh-secret", body)}`,
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ success: false, error: "Unauthorized" });
    const missing = await post(a, body);
    expect(missing.statusCode).toBe(401);
    expect(missing.body).toBe(bad.body);
  });

  it("verifies the exact bytes of a JSON body, not a re-serialisation", async () => {
    const a = serve(GITHUB);
    const body = JSON.stringify(JSON.parse(fixture("push-event.json")), null, 4);
    const res = await post(a, body, {
      "x-hub-signature-256": `sha256=${sign("gh-secret", body)}`,
    });
    expect(res.statusCode).toBe(201);
  });

  it("verifies a non-JSON body (form-encoded) by its raw bytes too", async () => {
    const a = serve("    preset: generic\n    auth:\n      secret_env: GH_SECRET");
    const body = "payload=%7B%22a%22%3A1%7D&x=%20";
    const res = await a.inject({
      method: "POST",
      url: "/webhook",
      payload: body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-signature": sign("gh-secret", body),
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("slack: signed event runs; stale timestamp is 401; url_verification returns the challenge", async () => {
    const a = serve("    preset: slack\n    auth:\n      secret_env: SLACK_SECRET");
    const headers = (ts: number, body: string) => ({
      "x-slack-request-timestamp": String(ts),
      "x-slack-signature": `v0=${sign("sl-secret", `v0:${ts}:${body}`)}`,
    });
    const event = fixture("slack-event.json");
    expect((await post(a, event, headers(NOW_S - 10, event))).statusCode).toBe(201);
    expect((await post(a, event, headers(NOW_S - 400, event))).statusCode).toBe(401);

    const v = fixture("slack-url-verification.json");
    const res = await post(a, v, headers(NOW_S, v));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ challenge: JSON.parse(v).challenge });
    expect((await post(a, v, {})).statusCode).toBe(401);
  });

  it("alertmanager: the bearer token is required", async () => {
    const a = serve("    preset: alertmanager\n    auth:\n      secret_env: AM_TOKEN");
    const body = fixture("alertmanager.json");
    expect((await post(a, body, { authorization: "Bearer am-token" })).statusCode).toBe(201);
    expect((await post(a, body, { authorization: "Bearer wrong" })).statusCode).toBe(401);
    expect((await post(a, body)).statusCode).toBe(401);
  });

  it("explicit bearer and explicit hmac work without a preset", async () => {
    const body = fixture("generic.json");
    const bearer = serve("    auth:\n      type: bearer\n      secret_env: AM_TOKEN");
    expect((await post(bearer, body, { authorization: "Bearer am-token" })).statusCode).toBe(201);
    await bearer.close();
    const hmac = serve(
      "    auth:\n      type: hmac\n      header: X-Sig\n      encoding: base64\n      secret_env: GH_SECRET",
    );
    const sig = createHmac("sha256", "gh-secret").update(body).digest("base64");
    expect((await post(hmac, body, { "x-sig": sig })).statusCode).toBe(201);
    expect((await post(hmac, body, { "x-sig": "nope" })).statusCode).toBe(401);
  });

  it("respond: sync checks auth before holding the request open or answering", async () => {
    const a = serve(
      `${GITHUB}\n    respond: sync\n    map:\n      repo: trigger.repository.full_name`,
    );
    const body = fixture("push-event.json");
    const denied = await post(a, body, { "x-hub-signature-256": "sha256=00" });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({ success: false, error: "Unauthorized" });
    expect(prompts).toEqual([]);

    const ok = await post(a, body, { "x-hub-signature-256": `sha256=${sign("gh-secret", body)}` });
    expect(ok.statusCode).toBe(200);
    expect(JSON.stringify(ok.json().output)).toContain("done");
  });

  it("when: a false predicate is 200 ignored, recorded as ignored, and starts no run", async () => {
    const a = serve(
      `${GITHUB}\n    map:\n      repo: trigger.repository.full_name\n    when: trigger.headers.\`x-github-event\` = "push"`,
    );
    const body = fixture("push-event.json");
    const sig = `sha256=${sign("gh-secret", body)}`;
    const ping = await post(a, body, { "x-hub-signature-256": sig, "x-github-event": "ping" });
    expect(ping.statusCode).toBe(200);
    expect(ping.json()).toMatchObject({ success: true, ignored: true });
    expect(ping.json().id).toBeUndefined();
    expect(prompts).toEqual([]);
    const ignored = (await a.inject({ method: "GET", url: "/triggers/ignored" })).json();
    expect(ignored.ignored).toHaveLength(1);

    const push = await post(a, body, { "x-hub-signature-256": sig, "x-github-event": "push" });
    expect(push.statusCode).toBe(201);
  });

  it("when does not run for an unauthenticated caller", async () => {
    const a = serve(`${GITHUB}\n    when: "false"`);
    const res = await post(a, fixture("push-event.json"));
    expect(res.statusCode).toBe(401);
    expect((await a.inject({ method: "GET", url: "/triggers/ignored" })).json().ignored).toEqual(
      [],
    );
  });

  it("map: the workflow reads the clean trigger.* the map built", async () => {
    const a = serve("    map:\n      repo: trigger.repository.full_name");
    const res = await post(a, fixture("push-event.json"));
    expect(res.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(prompts.join("\n")).toContain("acme/widgets");
  });

  it("a when that cannot be evaluated is 422 and runs nothing", async () => {
    const a = serve("    when: trigger.missing");
    const res = await post(a, "{}");
    expect(res.statusCode).toBe(422);
    expect(prompts).toEqual([]);
  });

  it("a spec without auth still takes any request, as before", async () => {
    const a = serve("    respond: async");
    expect((await post(a, "{}")).statusCode).toBe(201);
  });

  it("an unset secret fails closed with the same bare 401", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, spec(GITHUB));
    app = createServeServer({ specPath, run: { env: {} } });
    const res = await post(app, "{}", { "x-hub-signature-256": "sha256=00" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ success: false, error: "Unauthorized" });
  });

  it("other JSON routes still parse JSON bodies", async () => {
    const a = serve(GITHUB);
    const res = await post(a, JSON.stringify({ approved: true }), {}, "/runs/nope/approve");
    expect(res.statusCode).toBe(404);
  });
});
