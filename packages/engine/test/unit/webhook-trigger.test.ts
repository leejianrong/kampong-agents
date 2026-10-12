import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { handleWebhookRequest, triggerHeaders } from "../../src/webhook-trigger.js";

// KAN-1848 (ADR-0047): per-source inbound auth, the `when` filter and the `map` normaliser. Signed bodies
// are computed here, independently of the code under test, with a fixed clock.

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/webhooks/${name}`, import.meta.url)), "utf8");
const NOW_S = 1_700_000_000;
const now = () => NOW_S * 1000;
const hmac = (algo: string, secret: string, data: string, enc: "hex" | "base64" = "hex") =>
  createHmac(algo, secret).update(data).digest(enc);

const env = { GH_SECRET: "gh-secret", SLACK_SECRET: "sl-secret", AM_TOKEN: "am-token", GEN: "gen" };
const call = (
  trigger: Record<string, unknown>,
  body: string,
  headers: Record<string, string | string[] | undefined> = {},
) =>
  handleWebhookRequest(
    { type: "webhook", ...trigger },
    { headers: { "content-type": "application/json", ...headers }, rawBody: body },
    { env, now },
  );

describe("no auth", () => {
  it("runs every request, with the body as the input and the headers filtered", async () => {
    const body = fixture("generic.json");
    const d = await call({}, body, { authorization: "x", "x-event": "e" });
    expect(d.action).toBe("run");
    if (d.action === "run") {
      expect(d.trigger.headers).toEqual({ "content-type": "application/json", "x-event": "e" });
      expect(d.trigger.body).toEqual(JSON.parse(body));
    }
  });
  it("treats explicit none the same", async () => {
    expect((await call({ auth: "none" }, "{}")).action).toBe("run");
  });
});

describe("github preset", () => {
  const trigger = { preset: "github", auth: { secret_env: "GH_SECRET" } };
  const body = fixture("push-event.json");
  const sig = `sha256=${hmac("sha256", env.GH_SECRET, body)}`;

  it("accepts a correct X-Hub-Signature-256 over the exact bytes", async () => {
    expect((await call(trigger, body, { "x-hub-signature-256": sig })).action).toBe("run");
  });
  it("rejects a wrong secret, a changed body, a missing header and a missing prefix", async () => {
    const bad = `sha256=${hmac("sha256", "other", body)}`;
    expect((await call(trigger, body, { "x-hub-signature-256": bad })).action).toBe("reject");
    expect((await call(trigger, body + " ", { "x-hub-signature-256": sig })).action).toBe("reject");
    expect((await call(trigger, body, {})).action).toBe("reject");
    const noPrefix = hmac("sha256", env.GH_SECRET, body);
    expect((await call(trigger, body, { "x-hub-signature-256": noPrefix })).action).toBe("reject");
  });
  it("is byte-exact: whitespace-reformatted JSON does not verify", async () => {
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    expect((await call(trigger, pretty, { "x-hub-signature-256": sig })).action).toBe("reject");
  });
  it("rejects a signature of the wrong length without throwing", async () => {
    expect((await call(trigger, body, { "x-hub-signature-256": "sha256=ab" })).action).toBe(
      "reject",
    );
    expect((await call(trigger, body, { "x-hub-signature-256": ["a", "b"] })).action).toBe(
      "reject",
    );
  });
  it("fails closed, and says nothing about why, when the secret is not set", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = await handleWebhookRequest(
      { type: "webhook", ...trigger },
      { headers: { "x-hub-signature-256": sig }, rawBody: body },
      { env: {}, now },
    );
    expect(d).toEqual({
      action: "reject",
      status: 401,
      body: { success: false, error: "Unauthorized" },
    });
    expect(spy.mock.calls.join(" ")).toContain("GH_SECRET");
    spy.mockRestore();
  });
  it("401s identically for every failure, leaking no detail", async () => {
    const a = await call(trigger, body, {});
    const b = await call(trigger, body, { "x-hub-signature-256": "sha256=00" });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toMatch(/signature|secret|header|GH_SECRET/i);
  });
});

describe("slack preset", () => {
  const trigger = { preset: "slack", auth: { secret_env: "SLACK_SECRET" } };
  const body = fixture("slack-event.json");
  const sign = (ts: number, b = body) => ({
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": `v0=${hmac("sha256", env.SLACK_SECRET, `v0:${ts}:${b}`)}`,
  });

  it("accepts v0=HMAC of v0:ts:body", async () => {
    expect((await call(trigger, body, sign(NOW_S))).action).toBe("run");
  });
  it("accepts the edges of the 5 minute window and rejects beyond it, both directions", async () => {
    expect((await call(trigger, body, sign(NOW_S - 300))).action).toBe("run");
    expect((await call(trigger, body, sign(NOW_S + 300))).action).toBe("run");
    expect((await call(trigger, body, sign(NOW_S - 301))).action).toBe("reject");
    expect((await call(trigger, body, sign(NOW_S + 301))).action).toBe("reject");
  });
  it("rejects a replay of an old signed request, and a timestamp that is not seconds", async () => {
    expect((await call(trigger, body, sign(NOW_S - 3600))).action).toBe("reject");
    const h = sign(NOW_S);
    expect((await call(trigger, body, { ...h, "x-slack-request-timestamp": "abc" })).action).toBe(
      "reject",
    );
    expect((await call(trigger, body, { ...h, "x-slack-request-timestamp": "" })).action).toBe(
      "reject",
    );
  });
  it("rejects a valid signature presented with a different timestamp", async () => {
    const h = sign(NOW_S);
    expect(
      (await call(trigger, body, { ...h, "x-slack-request-timestamp": String(NOW_S + 1) })).action,
    ).toBe("reject");
  });
  it("answers a signed url_verification with its challenge, without running or applying when", async () => {
    const v = fixture("slack-url-verification.json");
    const d = await call({ ...trigger, when: "false" }, v, sign(NOW_S, v));
    expect(d).toEqual({
      action: "respond",
      status: 200,
      body: { challenge: JSON.parse(v).challenge },
    });
  });
  it("does not answer an unsigned url_verification", async () => {
    const v = fixture("slack-url-verification.json");
    expect((await call(trigger, v, {})).action).toBe("reject");
  });
  it("does not treat url_verification specially for other presets", async () => {
    const v = fixture("slack-url-verification.json");
    expect((await call({}, v)).action).toBe("run");
  });
  it("honours a narrower window_s", async () => {
    const t = { preset: "slack", auth: { secret_env: "SLACK_SECRET", window_s: 10 } };
    expect((await call(t, body, sign(NOW_S - 11))).action).toBe("reject");
    expect((await call(t, body, sign(NOW_S - 10))).action).toBe("run");
  });
});

describe("alertmanager preset (bearer)", () => {
  const trigger = { preset: "alertmanager", auth: { secret_env: "AM_TOKEN" } };
  const body = fixture("alertmanager.json");
  it("accepts the bearer token", async () => {
    expect((await call(trigger, body, { authorization: "Bearer am-token" })).action).toBe("run");
    expect((await call(trigger, body, { authorization: "bearer am-token" })).action).toBe("run");
  });
  it("rejects a wrong, missing, malformed or differently-schemed token", async () => {
    for (const authorization of [
      "Bearer nope",
      "Bearer ",
      "am-token",
      "Basic am-token",
      undefined,
    ]) {
      expect((await call(trigger, body, { authorization })).action, String(authorization)).toBe(
        "reject",
      );
    }
    expect((await call(trigger, body, { authorization: "Bearer am-tokenX" })).action).toBe(
      "reject",
    );
  });
  it("does not pass the authorization header on to the run", async () => {
    const d = await call(trigger, body, { authorization: "Bearer am-token" });
    expect(d.action === "run" && d.trigger.headers).toEqual({ "content-type": "application/json" });
  });
});

describe("generic and explicit hmac", () => {
  const body = fixture("generic.json");
  it("generic: X-Signature, hex sha256, no prefix", async () => {
    const t = { preset: "generic", auth: { secret_env: "GEN" } };
    expect((await call(t, body, { "x-signature": hmac("sha256", "gen", body) })).action).toBe(
      "run",
    );
    expect((await call(t, body, { "x-signature": "00" })).action).toBe("reject");
  });
  it("sha1, base64, a prefix and a custom header", async () => {
    const t = {
      auth: {
        type: "hmac",
        header: "X-Hook",
        algo: "sha1",
        encoding: "base64",
        prefix: "sha1=",
        secret_env: "GEN",
      },
    };
    const sig = `sha1=${hmac("sha1", "gen", body, "base64")}`;
    expect((await call(t, body, { "x-hook": sig })).action).toBe("run");
    expect((await call(t, body, { "x-hook": sig.slice(0, -2) + "xx" })).action).toBe("reject");
  });
  it("a timestamp without a payload template signs `<ts>.<body>`", async () => {
    const t = {
      auth: {
        type: "hmac",
        header: "x-sig",
        timestamp_header: "x-ts",
        window_s: 60,
        secret_env: "GEN",
      },
    };
    const sig = hmac("sha256", "gen", `${NOW_S}.${body}`);
    expect((await call(t, body, { "x-sig": sig, "x-ts": String(NOW_S) })).action).toBe("run");
    expect((await call(t, body, { "x-sig": sig, "x-ts": String(NOW_S - 61) })).action).toBe(
      "reject",
    );
  });
  it("verifies non-UTF-8 bytes exactly when given the raw buffer", async () => {
    const raw = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    const sig = createHmac("sha256", "gen").update(raw).digest("hex");
    const d = await handleWebhookRequest(
      { type: "webhook", preset: "generic", auth: { secret_env: "GEN" } } as never,
      { headers: { "x-signature": sig }, rawBody: raw },
      { env, now },
    );
    expect(d.action).toBe("run");
  });
});

describe("when and map", () => {
  const body = fixture("push-event.json");
  it("a false predicate ignores the request, with a reason, and does not run", async () => {
    const d = await call({ when: 'trigger.headers.`x-github-event` = "push"' }, body, {
      "x-github-event": "ping",
    });
    expect(d).toMatchObject({ action: "ignore" });
    expect((d as { reason: string }).reason).toContain("when");
  });
  it("a true predicate runs; it reads headers and body fields", async () => {
    const t = {
      when: 'trigger.headers.`x-github-event` = "push" and trigger.ref = "refs/heads/main"',
    };
    expect((await call(t, body, { "x-github-event": "push" })).action).toBe("run");
  });
  it("reads a body that is not JSON as text", async () => {
    expect((await call({ when: '$contains(trigger.body, "hi")' }, "oh hi there")).action).toBe(
      "run",
    );
  });
  it("a predicate that is not a boolean is a visible error, not a run", async () => {
    const d = await call({ when: "trigger.nope" }, body);
    expect(d).toMatchObject({ action: "error", status: 422 });
  });
  it("map replaces the body's fields with a clean trigger.*, keeping headers and body", async () => {
    const d = await call(
      {
        map: {
          repo: "trigger.repository.full_name",
          sha: "trigger.after",
          missing: "trigger.nope",
        },
      },
      body,
      { "x-github-event": "push" },
    );
    expect(d.action).toBe("run");
    if (d.action === "run") {
      expect(d.trigger.fields).toEqual({ repo: "acme/widgets", sha: "abc123", missing: null });
      expect(d.trigger.body).toEqual(JSON.parse(body));
      expect(d.trigger.headers).toMatchObject({ "x-github-event": "push" });
    }
  });
  it("auth is checked before when or map run", async () => {
    const t = {
      preset: "github",
      auth: { secret_env: "GH_SECRET" },
      when: "false",
      map: { a: "trigger.zzz" },
    };
    expect((await call(t, body, {})).action).toBe("reject");
  });
  it("a map expression that fails is a visible error", async () => {
    const d = await call({ map: { a: "$error('x')" } }, body);
    expect(d).toMatchObject({ action: "error", status: 422 });
  });
});

describe("triggerHeaders", () => {
  it("lowercases, joins lists and drops credential-looking headers", () => {
    expect(
      triggerHeaders({
        "X-A": "1",
        "Set-Cookie": "c",
        "x-b": ["1", "2"],
        "X-Api-Key": "k",
        u: undefined,
      }),
    ).toEqual({ "x-a": "1", "x-b": "1, 2" });
  });
});
