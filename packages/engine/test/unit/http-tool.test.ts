import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@kampong/spec";
import { callHttpTool, extractField, substitutePlaceholders } from "../../src/http-tool.js";

// SLICES.md V2 unit test plan: "Tool-call HTTP wrapper correctly
// substitutes {placeholders} and extracts the configured response field."
// Uses an injected fake fetch -- no live network call (AGENTS.md's testing
// approach).

describe("substitutePlaceholders", () => {
  it("substitutes every {placeholder} present in params", () => {
    expect(
      substitutePlaceholders("https://api.example.com/v1/charges/{charge_id}", {
        charge_id: "ch_123",
      }),
    ).toBe("https://api.example.com/v1/charges/ch_123");
  });

  it("leaves an unresolved placeholder untouched rather than guessing a value", () => {
    expect(substitutePlaceholders("https://api.example.com/{missing}", {})).toBe(
      "https://api.example.com/{missing}",
    );
  });

  it("substitutes a dotted, step-namespaced placeholder (workflow.ts's buildToolParams convention)", () => {
    expect(
      substitutePlaceholders("https://api.example.com/v1/charges/{parse_request.charge_id}", {
        "parse_request.charge_id": "ch_123",
      }),
    ).toBe("https://api.example.com/v1/charges/ch_123");
  });
});

describe("extractField", () => {
  it("extracts a nested field by dot path", () => {
    expect(extractField({ data: { status: "succeeded" } }, "data.status")).toBe("succeeded");
  });

  it("returns the whole payload when no extract path is configured", () => {
    const payload = { ok: true };
    expect(extractField(payload, undefined)).toBe(payload);
  });

  it("returns undefined for a path that doesn't resolve", () => {
    expect(extractField({ data: {} }, "data.status")).toBeUndefined();
  });
});

const CHECK_TOOL: Tool = {
  name: "check_stripe_charge",
  action: "http_request",
  method: "GET",
  url: "https://api.stripe.com/v1/charges/{charge_id}",
  extract: "data.status",
};

describe("callHttpTool", () => {
  it("calls the substituted URL and extracts the configured field", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe("https://api.stripe.com/v1/charges/ch_123");
      return new Response(JSON.stringify({ data: { status: "succeeded" } }), { status: 200 });
    });

    const result = await callHttpTool(
      CHECK_TOOL,
      { charge_id: "ch_123" },
      { fetchImpl: fetchImpl as typeof fetch },
    );
    expect(result).toBe("succeeded");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws a specific error naming the tool when the response is not ok", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 500, statusText: "Server Error" }),
    );

    await expect(
      callHttpTool(CHECK_TOOL, { charge_id: "ch_123" }, { fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toThrow(/check_stripe_charge.*500/);
  });

  it("throws a specific error naming the tool when the network call itself fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(
      callHttpTool(CHECK_TOOL, { charge_id: "ch_123" }, { fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toThrow(/check_stripe_charge.*ECONNREFUSED/);
  });

  it("passes the tool name as an explicit call argument, never as a literal HTTP header (finding #1)", async () => {
    // A tool name is an unrestricted, author-controlled string (schema only
    // requires z.string().min(1)) -- if it were ever stamped onto a real
    // Headers object, a newline or non-Latin1 character would throw a
    // TypeError from the ByteString conversion, breaking even a plain live
    // call. Prove no header carries the tool name: the fetch call receives
    // no `headers` at all, and the tool name instead arrives as the third
    // argument.
    const unsafeName = "weird\ntool☃name";
    const unsafeTool: Tool = { ...CHECK_TOOL, name: unsafeName };
    const fetchImpl = vi.fn(async (_url, init, context) => {
      expect(init?.headers).toBeUndefined();
      expect(context).toEqual({ toolName: unsafeName });
      // A real live call: proves this doesn't throw building/sending headers.
      new Headers(init?.headers);
      return new Response(JSON.stringify({ data: { status: "succeeded" } }), { status: 200 });
    });

    const result = await callHttpTool(unsafeTool, { charge_id: "ch_123" }, { fetchImpl });
    expect(result).toBe("succeeded");
  });
});
