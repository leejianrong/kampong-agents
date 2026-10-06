import { describe, expect, it } from "vitest";
import { parseComponentManifest, type AgentSpec } from "@kampong/spec";
import { createComponentDispatcher } from "../../src/component-dispatch.js";
import { createFirstPartyRegistry, InProcessModuleRunner } from "../../src/component-registry.js";
import type { ComponentRegistry, ResolvedComponent } from "../../src/component-registry.js";
import { runWorkflow, type ApprovalDecision, type RunEvent } from "../../src/workflow.js";
import type { ModelClient } from "../../src/model.js";

// KAN-1884 (ADR-0029): `action: component` tools dispatch through the registry into invokeOp, and
// the op's effect decides the approval default.

const MANIFEST = `kind: rest
id: acme/tickets
version: 1.0.0
permissions: { egress: [tickets.example.test] }
auth:
  slots:
    token:
      env: TICKETS_TOKEN
      hosts: [tickets.example.test]
      inject: { header: Authorization, template: "Bearer {{ secret }}" }
config:
  region: { type: string, default: eu }
ops:
  get:
    effect: read
    input:
      type: object
      required: [id]
      properties: { id: { type: string } }
    request:
      method: GET
      url: https://tickets.example.test/{{ config.region }}/tickets/{{ input.id }}
  create:
    effect: write
    input:
      type: object
      properties: { title: { type: string }, priority: { type: integer } }
    request:
      method: POST
      url: https://tickets.example.test/tickets
      body:
        json: { title: "{{ input.title }}", priority: "{{ input.priority }}" }
  purge:
    effect: destructive
    input: { type: object, properties: { id: { type: string } } }
    request:
      method: DELETE
      url: https://tickets.example.test/tickets/{{ input.id }}
`;

function registryOf(digest = "sha256:abc"): ComponentRegistry & { calls: unknown[] } {
  const parsed = parseComponentManifest(MANIFEST);
  if (!parsed.manifest)
    throw new Error(`fixture manifest invalid: ${JSON.stringify(parsed.errors)}`);
  const manifest = parsed.manifest;
  const calls: unknown[] = [];
  return {
    calls,
    async list() {
      return [];
    },
    async resolve(id, version, options) {
      calls.push({ id, version, options });
      if (id !== manifest.id || version !== manifest.version) {
        throw new Error(`component ${id}@${version} was not found`);
      }
      if (options?.expectedDigest && options.expectedDigest !== digest) {
        throw new Error(`component ${id}@${version} does not match its pinned digest`);
      }
      return { manifest, digest, dir: "/x" } satisfies ResolvedComponent;
    },
  };
}

const model: ModelClient = {
  async generateText() {
    return "text";
  },
  async generateStructured<T>() {
    return { result: { ticket_id: "T-7" }, confidence: 1 } as T;
  },
};

function spec(tool: Record<string, unknown>, workflowTail: unknown[] = []): AgentSpec {
  return {
    version: "1.0",
    agent: {
      id: "a",
      name: "A",
      role: "Tester",
      goal: "Call components.",
      tools: [{ name: "t", action: "component", use: "acme/tickets@1.0.0", ...tool }],
      workflow: [{ step: "call", type: "tool", tool: "t" }, ...workflowTail],
    },
  } as unknown as AgentSpec;
}

interface Seen {
  url: string;
  init?: RequestInit;
}

async function drive(
  agent: AgentSpec,
  deps: Record<string, unknown>,
  decide: (ev: Extract<RunEvent, { type: "awaiting_approval" }>) => ApprovalDecision = () => ({
    approved: true,
  }),
) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: "9", nested: { ok: true } }), { status: 200 });
  }) as unknown as typeof fetch;
  const events: RunEvent[] = [];
  const { registry, componentPins, requirePins, runner, runInput, ...rest } = deps as {
    runInput?: string;
    registry?: ComponentRegistry;
    componentPins?: Record<string, string> | (() => Record<string, string>);
    requirePins?: boolean;
    runner?: never;
  };
  const components = registry
    ? createComponentDispatcher({ registry, runner, pins: componentPins, requirePins })
    : undefined;
  const gen = runWorkflow(
    agent,
    { model, fetchImpl, env: { TICKETS_TOKEN: "tok" }, components, ...rest },
    runInput ?? "hello",
  );
  let next = await gen.next(undefined);
  while (!next.done) {
    events.push(next.value);
    next = await gen.next(next.value.type === "awaiting_approval" ? decide(next.value) : undefined);
  }
  return { events, seen };
}

const failed = (events: RunEvent[]) =>
  events.find((e): e is Extract<RunEvent, { type: "failed" }> => e.type === "failed");

describe("component tool dispatch", () => {
  it("runs the op through the registry, resolving {{ input }} and step references in `with`", async () => {
    const { events, seen } = await drive(spec({ op: "get", with: { id: "{{ input }}" } }), {
      registry: registryOf(),
    });
    expect(failed(events)).toBeUndefined();
    expect(seen[0]!.url).toBe("https://tickets.example.test/eu/tickets/hello");
    expect(new Headers(seen[0]!.init?.headers).get("authorization")).toBe("Bearer tok");
    expect(events.find((e) => e.type === "step_completed" && e.step === "call")).toMatchObject({
      output: { id: "9" },
    });
  });

  it("applies `extract` to the op result", async () => {
    const { events } = await drive(spec({ op: "get", with: { id: "1" }, extract: "nested.ok" }), {
      registry: registryOf(),
    });
    expect(events.find((e) => e.type === "step_completed" && e.step === "call")).toMatchObject({
      output: true,
    });
  });

  it("keeps non-string `with` values typed", async () => {
    const { seen } = await drive(spec({ op: "create", with: { title: "x", priority: 3 } }), {
      registry: registryOf(),
    });
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ title: "x", priority: 3 });
  });

  it("does not let `${ENV}` in `with` read the environment", async () => {
    const { seen } = await drive(spec({ op: "create", with: { title: "${TICKETS_TOKEN}" } }), {
      registry: registryOf(),
    });
    expect(String(seen[0]!.init?.body)).not.toContain("tok");
  });

  it("does not template `config` from run data (it forms part of the host)", async () => {
    const { events, seen } = await drive(
      spec({ op: "get", with: { id: "1" }, config: { region: "{{ input }}" } }),
      { registry: registryOf() },
    );
    expect(seen).toHaveLength(0);
    expect(failed(events)?.error).toMatch(/config\.region/);
  });

  it("remaps a secret slot to another environment variable", async () => {
    const { seen } = await drive(
      spec({ op: "get", with: { id: "1" }, secrets: { token: "${OTHER_TOKEN}" } }),
      { registry: registryOf(), env: { OTHER_TOKEN: "other" } },
    );
    expect(new Headers(seen[0]!.init?.headers).get("authorization")).toBe("Bearer other");
  });

  it("works from an execute_tool(...) condition branch too", async () => {
    const agent = spec({ op: "get", with: { id: "1" } }, [
      {
        step: "gate",
        type: "condition",
        if: 'call.id == "9"',
        then: "execute_tool(t)",
        else: "request_human_approval",
      },
    ]);
    const { events, seen } = await drive(agent, { registry: registryOf() });
    expect(failed(events)).toBeUndefined();
    expect(seen).toHaveLength(2);
  });

  it("fails visibly when no registry is configured", async () => {
    const { events, seen } = await drive(spec({ op: "get", with: { id: "1" } }), {});
    expect(seen).toHaveLength(0);
    expect(failed(events)?.error).toMatch(/registry/);
  });

  it("fails visibly when the component cannot be resolved", async () => {
    const { events, seen } = await drive(spec({ op: "get", use: "acme/missing@1.0.0" }), {
      registry: registryOf(),
    });
    expect(seen).toHaveLength(0);
    expect(failed(events)?.error).toMatch(/acme\/missing@1\.0\.0/);
  });

  it("fails visibly for an unknown op", async () => {
    const { events } = await drive(spec({ op: "nope" }), { registry: registryOf() });
    expect(failed(events)?.error).toMatch(/no op "nope"/);
  });

  it("passes a pinned digest to the registry and fails when it no longer matches", async () => {
    const registry = registryOf("sha256:new");
    const { events, seen } = await drive(spec({ op: "get", with: { id: "1" } }), {
      registry,
      componentPins: { "acme/tickets@1.0.0": "sha256:old" },
    });
    expect(seen).toHaveLength(0);
    expect(failed(events)?.error).toMatch(/pinned digest/);
  });
});

describe("component tool approval defaults", () => {
  it("a read op does not ask", async () => {
    const { events } = await drive(spec({ op: "get", with: { id: "1" } }), {
      registry: registryOf(),
    });
    expect(events.some((e) => e.type === "awaiting_approval")).toBe(false);
  });

  it("a write op does not ask by default", async () => {
    const { events } = await drive(spec({ op: "create", with: { title: "x" } }), {
      registry: registryOf(),
    });
    expect(events.some((e) => e.type === "awaiting_approval")).toBe(false);
  });

  it("a destructive op asks first, and a rejection sends nothing", async () => {
    const { events, seen } = await drive(
      spec({ op: "purge", with: { id: "1" } }),
      { registry: registryOf() },
      () => ({ approved: false, reason: "no" }),
    );
    expect(events.find((e) => e.type === "awaiting_approval")).toMatchObject({
      kind: "tool",
      toolName: "t",
    });
    expect(events.some((e) => e.type === "rejected")).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("a destructive op runs once approved", async () => {
    const { seen } = await drive(spec({ op: "purge", with: { id: "1" } }), {
      registry: registryOf(),
    });
    expect(seen).toHaveLength(1);
  });

  it("an explicit requires_approval: false overrides the destructive default", async () => {
    const { events, seen } = await drive(
      spec({ op: "purge", with: { id: "1" }, requires_approval: false }),
      { registry: registryOf() },
    );
    expect(events.some((e) => e.type === "awaiting_approval")).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("an explicit requires_approval: true makes a read op ask", async () => {
    const { events } = await drive(
      spec({ op: "get", with: { id: "1" }, requires_approval: true }),
      { registry: registryOf() },
    );
    expect(events.some((e) => e.type === "awaiting_approval")).toBe(true);
  });

  it("an unresolvable component fails before asking for approval", async () => {
    const { events } = await drive(spec({ op: "purge", use: "acme/missing@1.0.0" }), {
      registry: registryOf(),
    });
    expect(events.some((e) => e.type === "awaiting_approval")).toBe(false);
    expect(failed(events)).toBeDefined();
  });
});

describe("pin enforcement (kampong.lock)", () => {
  it("with requirePins, a component that has no pin fails before any approval or request", async () => {
    const { events, seen } = await drive(spec({ op: "purge", with: { id: "1" } }), {
      registry: registryOf(),
      requirePins: true,
      componentPins: {},
    });
    expect(seen).toHaveLength(0);
    expect(events.some((e) => e.type === "awaiting_approval")).toBe(false);
    expect(failed(events)?.error).toMatch(/not pinned.*kampong lock/s);
  });

  it("with requirePins, a matching pin runs the call", async () => {
    const { events, seen } = await drive(spec({ op: "get", with: { id: "1" } }), {
      registry: registryOf("sha256:abc"),
      requirePins: true,
      componentPins: { "acme/tickets@1.0.0": "sha256:abc" },
    });
    expect(failed(events)).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("reads pins afresh for every call, so an edited lockfile takes effect without a restart", async () => {
    let pins: Record<string, string> = { "acme/tickets@1.0.0": "sha256:old" };
    const registry = registryOf("sha256:abc");
    const first = await drive(spec({ op: "get", with: { id: "1" } }), {
      registry,
      requirePins: true,
      componentPins: () => pins,
    });
    expect(failed(first.events)?.error).toMatch(/pinned digest/);
    pins = { "acme/tickets@1.0.0": "sha256:abc" };
    const second = await drive(spec({ op: "get", with: { id: "1" } }), {
      registry,
      requirePins: true,
      componentPins: () => pins,
    });
    expect(failed(second.events)).toBeUndefined();
  });

  it("surfaces a failure to read the pins as a visible run failure", async () => {
    const { events, seen } = await drive(spec({ op: "get", with: { id: "1" } }), {
      registry: registryOf(),
      requirePins: true,
      componentPins: () => {
        throw new Error("kampong.lock is not valid");
      },
    });
    expect(seen).toHaveLength(0);
    expect(failed(events)?.error).toMatch(/kampong\.lock is not valid/);
  });
});

describe("templated values for typed fields", () => {
  it("converts a number or boolean that arrives as text from a {{ reference }}", async () => {
    const { events, seen } = await drive(
      spec({ op: "create", with: { title: "x", priority: "{{ input }}" } }),
      { registry: registryOf(), runInput: "3" },
    );
    expect(failed(events)).toBeUndefined();
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ title: "x", priority: 3 });
  });

  it("still rejects text that is not a number, naming the field", async () => {
    const { events, seen } = await drive(
      spec({ op: "create", with: { title: "x", priority: "{{ input }}" } }),
      { registry: registryOf(), runInput: "high" },
    );
    expect(seen).toHaveLength(0);
    expect(failed(events)?.error).toMatch(/priority must be an integer/);
  });

  it("does not turn text into a number for a string field", async () => {
    const { seen } = await drive(spec({ op: "create", with: { title: "{{ input }}" } }), {
      registry: registryOf(),
      runInput: "42",
    });
    expect(JSON.parse(String(seen[0]!.init?.body)).title).toBe("42");
  });

  it("does not convert a hand-written literal: only a {{ reference }} result is converted", async () => {
    const { events, seen } = await drive(
      spec({ op: "create", with: { title: "x", priority: "3" } }),
      { registry: registryOf() },
    );
    expect(seen).toHaveLength(0);
    expect(failed(events)?.error).toMatch(/priority must be an integer/);
  });

  it("leaves a digit string too large to be exact as text, so validation rejects it", async () => {
    const { events, seen } = await drive(
      spec({ op: "create", with: { title: "x", priority: "{{ input }}" } }),
      { registry: registryOf(), runInput: "9007199254740993" },
    );
    expect(seen).toHaveLength(0);
    expect(failed(events)?.error).toMatch(/priority/);
  });

  it("does not accept hex, exponent or padded text as a number", async () => {
    for (const text of ["0x10", "1e3", " 3 ", ""]) {
      const { events, seen } = await drive(
        spec({ op: "create", with: { title: "x", priority: "{{ input }}" } }),
        { registry: registryOf(), runInput: text },
      );
      expect(seen, text).toHaveLength(0);
      expect(failed(events), text).toBeDefined();
    }
  });
});

describe("legacy Slack and Gmail tools with a component dispatcher (KAN-1886)", () => {
  async function runLegacy(
    tool: Record<string, unknown>,
    fetchBody: unknown = { ok: true, ts: "1.2" },
  ) {
    const registry = createFirstPartyRegistry();
    const components = createComponentDispatcher({
      registry,
      runner: new InProcessModuleRunner(registry, {}, { requirePins: true }),
      // No pins at all: first-party components do not need a lockfile entry.
      requirePins: true,
    });
    const seen: { url: string; body?: unknown }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: init?.body });
      return new Response(JSON.stringify(fetchBody), { status: 200 });
    }) as unknown as typeof fetch;
    const agent = {
      version: "1.0",
      agent: {
        id: "a",
        name: "A",
        role: "R",
        goal: "G",
        tools: [{ name: "t", ...tool }],
        workflow: [{ step: "go", type: "tool", tool: "t" }],
      },
    } as unknown as AgentSpec;
    const events: RunEvent[] = [];
    const gen = runWorkflow(
      agent,
      { model, fetchImpl, components, env: { SLACK_BOT_TOKEN: "xoxb-1", GMAIL_TOKEN: "ya29" } },
      "hello",
    );
    let next = await gen.next(undefined);
    while (!next.done) {
      events.push(next.value);
      next = await gen.next(undefined);
    }
    return { events, seen };
  }

  it("runs slack_post_message as kampong/slack without a lockfile entry", async () => {
    const { events, seen } = await runLegacy({
      action: "slack_post_message",
      token: "${SLACK_BOT_TOKEN}",
      channel: "#ops",
      text: "got {{ input }}",
    });
    expect(failed(events)).toBeUndefined();
    expect(seen[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(JSON.parse(String(seen[0]?.body))).toEqual({ channel: "#ops", text: "got hello" });
  });

  it("runs gmail_send as kampong/gmail", async () => {
    const { events, seen } = await runLegacy(
      {
        action: "gmail_send",
        token: "${GMAIL_TOKEN}",
        to: "a@b.c",
        subject: "hi",
        body: "{{ input }}",
      },
      { id: "m1" },
    );
    expect(failed(events)).toBeUndefined();
    expect(seen[0]?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  });

  it("surfaces a Slack ok:false as a failed step", async () => {
    const { events } = await runLegacy(
      { action: "slack_post_message", token: "${SLACK_BOT_TOKEN}", channel: "#x", text: "t" },
      { ok: false, error: "channel_not_found" },
    );
    expect(failed(events)?.error).toMatch(/channel_not_found/);
  });

  it("still requires a pin for a user component when first-party ones do not", async () => {
    const { events, seen } = await drive(spec({ op: "get", with: { id: "1" } }), {
      registry: registryOf(),
      requirePins: true,
      componentPins: {},
    });
    expect(seen).toHaveLength(0);
    expect(failed(events)?.error).toMatch(/not pinned/);
  });
});
