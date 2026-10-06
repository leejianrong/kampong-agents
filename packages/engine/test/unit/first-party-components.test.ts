import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Tool } from "@kampong/spec";
import { buildToolRequest } from "../../src/http-tool.js";
import { createComponentDispatcher } from "../../src/component-dispatch.js";
import {
  ComponentResolutionError,
  createFirstPartyRegistry,
  DirectoryComponentRegistry,
  InProcessModuleRunner,
  LayeredComponentRegistry,
  isFirstPartyId,
} from "../../src/component-registry.js";
import { desugarLegacyTool } from "../../src/workflow.js";

// KAN-1886 (ADR-0025): Slack and Gmail re-expressed as first-party components, and the legacy tool
// kinds desugared onto them. The legacy builder is the oracle: the same input must produce the same
// request on the wire.

describe("first-party components folder", () => {
  const dir = fileURLToPath(new URL("../../components", import.meta.url));
  const registry = new DirectoryComponentRegistry(dir, { firstParty: true });

  it("has no manifest that fails to load or sits at the wrong path", async () => {
    expect(await registry.problems()).toEqual([]);
  });

  it("ships kampong/slack and kampong/gmail", async () => {
    const ids = (await registry.list()).map((c) => `${c.id}@${c.version}`).sort();
    expect(ids).toEqual(["kampong/gmail@1.0.0", "kampong/slack@1.0.0"]);
  });

  it("declares Apache-2.0 on every component", async () => {
    for (const summary of await registry.list()) {
      const { manifest } = await registry.resolve(summary.id, summary.version);
      expect(manifest.license, summary.id).toBe("Apache-2.0");
    }
  });

  it("binds each secret slot to its own API host only", async () => {
    const slack = (await registry.resolve("kampong/slack", "1.0.0")).manifest;
    const gmail = (await registry.resolve("kampong/gmail", "1.0.0")).manifest;
    expect(slack.auth?.slots.token?.hosts).toEqual(["slack.com"]);
    expect(gmail.auth?.slots.token?.hosts).toEqual(["gmail.googleapis.com"]);
    expect(slack.permissions?.egress).toEqual(["slack.com"]);
    expect(gmail.permissions?.egress).toEqual(["gmail.googleapis.com"]);
  });
});

describe("LayeredComponentRegistry", () => {
  it("routes kampong/* to the first-party registry only, and everything else to the user's", async () => {
    const firstParty = createFirstPartyRegistry();
    const user = new DirectoryComponentRegistry("/nonexistent");
    const layered = new LayeredComponentRegistry(user, firstParty);
    expect((await layered.resolve("kampong/slack", "1.0.0")).manifest.id).toBe("kampong/slack");
    await expect(layered.resolve("acme/none", "1.0.0")).rejects.toBeInstanceOf(
      ComponentResolutionError,
    );
    expect((await layered.list()).map((c) => c.id)).toContain("kampong/gmail");
  });

  it("never lets the user's folder supply a kampong/* component", async () => {
    const userFake: ConstructorParameters<typeof LayeredComponentRegistry>[0] = {
      async list() {
        return [];
      },
      async resolve() {
        throw new Error("the user registry must not be asked for kampong/*");
      },
    };
    const layered = new LayeredComponentRegistry(userFake, createFirstPartyRegistry());
    await expect(layered.resolve("kampong/slack", "1.0.0")).resolves.toBeDefined();
  });

  it("recognises first-party ids by their reserved namespace", () => {
    expect(isFirstPartyId("kampong/slack")).toBe(true);
    expect(isFirstPartyId("kampongx/slack")).toBe(false);
    expect(isFirstPartyId("acme/kampong")).toBe(false);
  });
});

describe("desugarLegacyTool", () => {
  it("maps slack_post_message and gmail_send to component calls, keeping name, token, approval and extract", () => {
    expect(
      desugarLegacyTool({
        name: "n",
        action: "slack_post_message",
        token: "${T}",
        channel: "#c",
        text: "hi",
        requires_approval: true,
        extract: "ts",
      }),
    ).toEqual({
      name: "n",
      action: "component",
      use: "kampong/slack@1.0.0",
      op: "post_message",
      with: { channel: "#c", text: "hi" },
      secrets: { token: "${T}" },
      requires_approval: true,
      extract: "ts",
    });
    expect(
      desugarLegacyTool({
        name: "m",
        action: "gmail_send",
        token: "${G}",
        to: "a@b.c",
        subject: "s",
        body: "b",
      }),
    ).toEqual({
      name: "m",
      action: "component",
      use: "kampong/gmail@1.0.0",
      op: "send",
      with: { to: "a@b.c", subject: "s", body: "b" },
      secrets: { token: "${G}" },
    });
  });

  it("leaves http_request and component tools alone", () => {
    expect(
      desugarLegacyTool({
        name: "h",
        action: "http_request",
        method: "GET",
        url: "https://x.test",
      }),
    ).toBeUndefined();
    expect(
      desugarLegacyTool({ name: "c", action: "component", use: "a/b@1.0.0", op: "o" }),
    ).toBeUndefined();
  });
});

// ---- Parity with the legacy builders ---------------------------------------------------------------

interface Captured {
  url: string;
  method?: string;
  body?: string;
  authorization: string | null;
}

async function runDesugared(
  tool: Tool,
  params: Record<string, string>,
  env: NodeJS.ProcessEnv,
  response: unknown = { ok: true },
): Promise<{ captured: Captured; output: unknown }> {
  const captured: Captured = { url: "", authorization: null };
  const registry = createFirstPartyRegistry();
  const dispatcher = createComponentDispatcher({
    registry,
    runner: new InProcessModuleRunner(registry),
  });
  const component = desugarLegacyTool(tool)!;
  const prepared = await dispatcher.prepare(component);
  // The same substitution the workflow applies to `with`.
  const { substitutePlaceholders } = await import("../../src/http-tool.js");
  const withInput = Object.fromEntries(
    Object.entries(component.with ?? {}).map(([k, v]) => [
      k,
      substitutePlaceholders(String(v), params),
    ]),
  );
  const output = await prepared.run(withInput, {
    env,
    fetchImpl: async (url, init) => {
      captured.url = String(url);
      captured.method = init?.method;
      captured.body = typeof init?.body === "string" ? init.body : undefined;
      captured.authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify(response), { status: 200 });
    },
  });
  return { captured, output };
}

const SLACK: Tool = {
  name: "n",
  action: "slack_post_message",
  token: "${SLACK_BOT_TOKEN}",
  channel: "#support",
  text: "New reply: {{ draft.text }}",
};
const GMAIL: Tool = {
  name: "m",
  action: "gmail_send",
  token: "${GMAIL_TOKEN}",
  to: "customer@example.com",
  subject: "Re: {{ classify.category }}",
  body: "Thanks {{ draft.text }}",
};

describe.each([
  ["plain", { "draft.text": "hello", "classify.category": "refund" }],
  ["unicode and quotes", { "draft.text": 'café "quoted" 日本語', "classify.category": "x" }],
  ["a literal ${ENV} reference", { "draft.text": "${SLACK_BOT_TOKEN}", "classify.category": "y" }],
  ["multi-line text", { "draft.text": "line1\nline2\r\nline3", "classify.category": "z" }],
])("desugared request equals the legacy request: %s", (_name, params) => {
  const env = { SLACK_BOT_TOKEN: "xoxb-1", GMAIL_TOKEN: "ya29" };

  it("Slack", async () => {
    const legacy = buildToolRequest(SLACK, params, env);
    const { captured } = await runDesugared(SLACK, params, env);
    expect(captured.url).toBe(legacy.url);
    expect(captured.method).toBe(legacy.method);
    expect(captured.body).toBe(legacy.body);
    expect(captured.authorization).toBe(legacy.headers.Authorization);
  });

  it("Gmail", async () => {
    const legacy = buildToolRequest(GMAIL, params, env);
    const { captured } = await runDesugared(GMAIL, params, env);
    expect(captured.url).toBe(legacy.url);
    expect(captured.method).toBe(legacy.method);
    expect(captured.body).toBe(legacy.body);
    expect(captured.authorization).toBe(legacy.headers.Authorization);
  });
});

describe("first-party behaviour that improves on the legacy path", () => {
  const env = { SLACK_BOT_TOKEN: "xoxb-1", GMAIL_TOKEN: "ya29" };

  it("Slack: an ok:false answer (HTTP 200) is a visible failure, not a success", async () => {
    await expect(
      runDesugared(SLACK, { "draft.text": "x" }, env, { ok: false, error: "channel_not_found" }),
    ).rejects.toThrow(/channel_not_found/);
  });

  it.each(["to", "subject"])(
    "Gmail: a line break in %s is refused, so a step output cannot add headers such as Bcc",
    async (field) => {
      const tool = { ...GMAIL, [field]: "a@b.c\r\nBcc: attacker@evil.test" } as Tool;
      await expect(runDesugared(tool, {}, env)).rejects.toThrow(/line break/);
    },
  );

  it("Gmail: the token never reaches a host other than Google's", async () => {
    // The module can only fetch gmail.googleapis.com once it has read the token.
    const registry = createFirstPartyRegistry();
    const { manifest } = await registry.resolve("kampong/gmail", "1.0.0");
    expect(manifest.permissions?.egress).toEqual(["gmail.googleapis.com"]);
  });

  it("Gmail: a non-2xx answer is a visible failure that does not echo the token", async () => {
    const registry = createFirstPartyRegistry();
    const dispatcher = createComponentDispatcher({
      registry,
      runner: new InProcessModuleRunner(registry),
    });
    const prepared = await dispatcher.prepare(desugarLegacyTool(GMAIL)!);
    const err = await prepared
      .run(
        { to: "a@b.c", subject: "s", body: "b" },
        {
          env,
          fetchImpl: async () => new Response("denied for ya29", { status: 401 }),
        },
      )
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/401/);
    expect((err as Error).message).not.toContain("ya29");
  });
});

describe("legacy compatibility of the desugared path", () => {
  const env = { SLACK_BOT_TOKEN: "xoxb-1", GMAIL_TOKEN: "ya29" };

  async function toolNameSeenByFetch(tool: Tool): Promise<string | undefined> {
    const registry = createFirstPartyRegistry();
    const dispatcher = createComponentDispatcher({
      registry,
      runner: new InProcessModuleRunner(registry),
    });
    const prepared = await dispatcher.prepare(desugarLegacyTool(tool)!, { legacy: true });
    let seen: string | undefined;
    await prepared.run(
      tool.action === "slack_post_message"
        ? { channel: "#c", text: "t" }
        : { to: "a@b.c", subject: "s", body: "b" },
      {
        env,
        toolName: tool.name,
        fetchImpl: async (_url, _init, ctx) => {
          seen = ctx?.toolName;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    );
    return seen;
  }

  it("shows the record/replay layer the tool's own name, so fixtures recorded before still match", async () => {
    expect(await toolNameSeenByFetch({ ...SLACK, name: "notify_support" })).toBe("notify_support");
    expect(await toolNameSeenByFetch({ ...GMAIL, name: "send_reply" })).toBe("send_reply");
  });

  it("does not read the lockfile pins for a legacy tool, so a broken lockfile cannot break it", async () => {
    const registry = createFirstPartyRegistry();
    const dispatcher = createComponentDispatcher({
      registry,
      runner: new InProcessModuleRunner(registry, () => {
        throw new Error("kampong.lock is not valid");
      }),
      pins: () => {
        throw new Error("kampong.lock is not valid");
      },
      requirePins: true,
    });
    const prepared = await dispatcher.prepare(desugarLegacyTool(SLACK)!, { legacy: true });
    await expect(
      prepared.run(
        { channel: "#c", text: "t" },
        { env, fetchImpl: async () => new Response(JSON.stringify({ ok: true })) },
      ),
    ).resolves.toBeDefined();
    const gmail = await dispatcher.prepare(desugarLegacyTool(GMAIL)!, { legacy: true });
    await expect(
      gmail.run(
        { to: "a@b.c", subject: "s", body: "b" },
        { env, fetchImpl: async () => new Response(JSON.stringify({ id: "1" })) },
      ),
    ).resolves.toBeDefined();
  });

  it("still reports an unreadable lockfile for a component the project pins itself", async () => {
    const registry = createFirstPartyRegistry();
    const dispatcher = createComponentDispatcher({
      registry,
      pins: () => {
        throw new Error("kampong.lock is not valid");
      },
      requirePins: true,
    });
    await expect(
      dispatcher.prepare({
        name: "x",
        action: "component",
        use: "acme/other@1.0.0",
        op: "o",
      }),
    ).rejects.toThrow(/kampong\.lock is not valid/);
  });

  it("Gmail: reports Google's error status and message, without the token", async () => {
    const registry = createFirstPartyRegistry();
    const dispatcher = createComponentDispatcher({
      registry,
      runner: new InProcessModuleRunner(registry),
    });
    const prepared = await dispatcher.prepare(desugarLegacyTool(GMAIL)!, { legacy: true });
    const err = await prepared
      .run(
        { to: "a@b.c", subject: "s", body: "b" },
        {
          env,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                error: {
                  status: "PERMISSION_DENIED",
                  message: "Request had insufficient authentication scopes. token ya29",
                },
              }),
              { status: 403 },
            ),
        },
      )
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/403/);
    expect((err as Error).message).toMatch(/PERMISSION_DENIED/);
    expect((err as Error).message).toMatch(/insufficient authentication scopes/);
    expect((err as Error).message).not.toContain("ya29");
  });
});
