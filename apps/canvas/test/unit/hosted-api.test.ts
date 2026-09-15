import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createHostedClient,
  createHostedSpecClient,
  detectServerMode,
  guardUnauthorized,
  starterSpec,
  type HostedClient,
} from "../../src/api.js";

// KAN-1228 (ADR-0020): the hosted client and its per-spec `ApiClient`, plus
// the server-mode probe and the 401 gate. Route the request shapes rather
// than asserting on a single global fetch so a change to one endpoint can't
// silently pass another's assertion.

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

/** A fetch double that dispatches on `${method} ${path}`. */
function routedFetch(routes: Record<string, (url: string, init?: RequestInit) => Response>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(url, "http://localhost").pathname;
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unrouted ${method} ${path}`);
    return handler(url, init);
  });
}

describe("detectServerMode", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports hosted when /api/auth/get-session answers 2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, null)),
    );
    await expect(detectServerMode()).resolves.toBe("hosted");
  });

  it("reports local when the auth probe 404s (the local kampong dev server)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, {})),
    );
    await expect(detectServerMode()).resolves.toBe("local");
  });

  it("reports local when the probe network-errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    await expect(detectServerMode()).resolves.toBe("local");
  });
});

describe("createHostedClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("getSession returns null for a signed-out session body", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({ "GET /api/auth/get-session": () => jsonResponse(200, null) }),
    );
    await expect(createHostedClient().getSession()).resolves.toBeNull();
  });

  it("getSession returns the session when signed in", async () => {
    const session = {
      user: { id: "u1", email: "a@b.co", name: "A" },
      session: { activeOrganizationId: "w1" },
    };
    vi.stubGlobal(
      "fetch",
      routedFetch({ "GET /api/auth/get-session": () => jsonResponse(200, session) }),
    );
    await expect(createHostedClient().getSession()).resolves.toEqual(session);
  });

  it("listSpecs unwraps the { specs } envelope", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /api/specs": () =>
          jsonResponse(200, { success: true, specs: [{ id: "s1", name: "One" }] }),
      }),
    );
    await expect(createHostedClient().listSpecs()).resolves.toEqual([{ id: "s1", name: "One" }]);
  });

  it("createSpec surfaces validation errors as a joined ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "POST /api/specs": () =>
          jsonResponse(422, { success: false, errors: [{ path: ["agent"], message: "bad spec" }] }),
      }),
    );
    await expect(createHostedClient().createSpec("x", "not: valid")).rejects.toThrow(/bad spec/);
  });

  it("listByokKeys unwraps the { keys } envelope; putByokKey targets the provider path", async () => {
    const put = vi.fn((_url: string, _init?: RequestInit) =>
      jsonResponse(200, { success: true, provider: "openai", lastFour: "ab12" }),
    );
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /api/byok": () =>
          jsonResponse(200, {
            success: true,
            keys: [{ provider: "openai", lastFour: "ab12", updatedAt: "t" }],
          }),
        "PUT /api/byok/openai": put,
      }),
    );
    const api = createHostedClient();
    await expect(api.listByokKeys()).resolves.toEqual([
      { provider: "openai", lastFour: "ab12", updatedAt: "t" },
    ]);
    await api.putByokKey("openai", "sk-secret");
    // Sent to the provider-scoped path with the key in the body.
    expect(put).toHaveBeenCalledOnce();
    const init = put.mock.calls[0]?.[1];
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual({ key: "sk-secret" });
  });
});

describe("createHostedSpecClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("addresses the spec by id and starts runs under it", async () => {
    const start = vi.fn((_url: string, _init?: RequestInit) =>
      jsonResponse(201, { success: true, id: "r1", state: {} }),
    );
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /api/specs/s1": () =>
          jsonResponse(200, { success: true, spec: {}, errors: [], layout: {}, source: "" }),
        "PUT /api/specs/s1": () => jsonResponse(200, { success: true, spec: {} }),
        "POST /api/specs/s1/runs": start,
      }),
    );
    const client = createHostedSpecClient("", "s1");
    await expect(client.loadSpec()).resolves.toMatchObject({ success: true });
    await client.applyPatch([{ op: "set", path: ["agent", "goal"], value: "hi" }]);
    await client.startRun("hello");
    expect(start).toHaveBeenCalledOnce();
  });

  it("loadSpec throws ApiError(401) so the shell can re-gate on login", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /api/specs/s1": () =>
          jsonResponse(401, { success: false, error: "Authentication required." }),
      }),
    );
    const client = createHostedSpecClient("", "s1");
    await expect(client.loadSpec()).rejects.toBeInstanceOf(ApiError);
    await expect(client.loadSpec()).rejects.toMatchObject({ status: 401 });
  });

  it("subscribeToEvents is a no-op (hosted specs have no file watcher)", () => {
    const client = createHostedSpecClient("", "s1");
    const unsubscribe = client.subscribeToEvents(() => {});
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe("guardUnauthorized", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls onUnauthorized on a 401 from a control method, then rethrows", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /api/specs": () =>
          jsonResponse(401, { success: false, error: "Authentication required." }),
      }),
    );
    const onUnauthorized = vi.fn();
    const guarded = guardUnauthorized(createHostedClient(), onUnauthorized);
    await expect(guarded.listSpecs()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("does not fire onUnauthorized for a non-401 failure", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({ "GET /api/specs": () => jsonResponse(500, { error: "boom" }) }),
    );
    const onUnauthorized = vi.fn();
    const guarded: HostedClient = guardUnauthorized(createHostedClient(), onUnauthorized);
    await expect(guarded.listSpecs()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("guards the per-spec client's loadSpec too", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /api/specs/s1": () =>
          jsonResponse(401, { success: false, error: "Authentication required." }),
      }),
    );
    const onUnauthorized = vi.fn();
    const guarded = guardUnauthorized(createHostedClient(), onUnauthorized);
    await expect(guarded.specClient("s1").loadSpec()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});

describe("starterSpec", () => {
  it("produces a schema-shaped starter naming the workspace agent", () => {
    const yaml = starterSpec("Support Triage");
    expect(yaml).toContain('name: "Support Triage"');
    expect(yaml).toContain("workflow:");
    expect(yaml).toContain("provider: openrouter");
    // The placeholder is only there to satisfy validation; the real key comes
    // from the workspace BYOK store at run time (ADR-0016).
    expect(yaml).toContain("${OPENROUTER_API_KEY}");
  });
});
