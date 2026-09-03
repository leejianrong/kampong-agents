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
});
