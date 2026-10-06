import { describe, expect, it } from "vitest";
import { parseComponentManifest, type AgentSpec } from "@kampong/spec";
import { createComponentDispatcher } from "../../src/component-dispatch.js";
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
  const { registry, componentPins, runner, ...rest } = deps as {
    registry?: ComponentRegistry;
    componentPins?: Record<string, string>;
    runner?: never;
  };
  const components = registry
    ? createComponentDispatcher({ registry, runner, pins: componentPins })
    : undefined;
  const gen = runWorkflow(
    agent,
    { model, fetchImpl, env: { TICKETS_TOKEN: "tok" }, components, ...rest },
    "hello",
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
