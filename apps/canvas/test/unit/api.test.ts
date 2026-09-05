import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../../src/api.js";

// KAN-1216: loadSpec()/applyPatch() used to parse and cast a non-2xx
// response straight to the expected success-shaped DTO -- a raw Fastify
// error envelope (e.g. `{ statusCode: 500, code: "ENOENT", ... }`, no
// `success`/`errors` fields at all) came back as `success: undefined`,
// which callers that only checked `.success`/`.errors` treated as "nothing
// to report". These now check `res.ok` first and throw a typed `ApiError`
// instead, so a caller can catch it and show a real error.

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("createApiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loadSpec resolves normally on a 200 response", async () => {
    const body = { success: true, errors: [], layout: {}, source: "version: '1.0'\n" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, body)),
    );

    const api = createApiClient();
    await expect(api.loadSpec()).resolves.toEqual(body);
  });

  it("loadSpec throws an ApiError with a clean message on a 404 (spec file deleted)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse(404, {
          success: false,
          error: "Spec file not found: agent.yaml. It may have been deleted or moved.",
        }),
      ),
    );

    const api = createApiClient();
    await expect(api.loadSpec()).rejects.toThrow(ApiError);
    await expect(api.loadSpec()).rejects.toThrow(/Spec file not found/);
  });

  it("loadSpec throws a generic ApiError when the error body isn't the expected shape", async () => {
    // Mirrors Fastify's own default error envelope, which has no
    // `success`/`error` fields at all -- exactly the malformed-body case
    // that used to slip through as a false "success".
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse(500, {
          statusCode: 500,
          code: "ENOENT",
          error: "Internal Server Error",
        }),
      ),
    );

    const api = createApiClient();
    // The body's `error` field here is Fastify's generic "Internal Server
    // Error" string, not a domain message -- either way this must reject,
    // not resolve with a garbage-shaped success value.
    await expect(api.loadSpec()).rejects.toThrow(ApiError);
  });

  it("applyPatch resolves normally on a 200 response", async () => {
    const body = { success: true, spec: { version: "1.0" } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, body)),
    );

    const api = createApiClient();
    await expect(
      api.applyPatch([{ op: "set", path: ["agent", "goal"], value: "hi" }]),
    ).resolves.toEqual(body);
  });

  it("applyPatch throws an ApiError on a 404 (spec file deleted) instead of returning a garbage success value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse(404, {
          success: false,
          error: "Spec file not found: agent.yaml. It may have been deleted or moved.",
        }),
      ),
    );

    const api = createApiClient();
    await expect(
      api.applyPatch([{ op: "set", path: ["agent", "goal"], value: "hi" }]),
    ).rejects.toThrow(/Spec file not found/);
  });

  it("applyPatch throws an ApiError with the joined validation messages on a 422", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse(422, {
          success: false,
          errors: [{ path: ["agent", "workflow", 0, "step"], message: "must not be empty" }],
        }),
      ),
    );

    const api = createApiClient();
    await expect(
      api.applyPatch([{ op: "set", path: ["agent", "workflow", 0, "step"], value: "" }]),
    ).rejects.toThrow(/must not be empty/);
  });
});
