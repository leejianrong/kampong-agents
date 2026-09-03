import { describe, expect, it } from "vitest";
import { buildToolFromForm } from "../../src/tool-form.js";

describe("buildToolFromForm", () => {
  it("builds a valid tool spec fragment from structured input alone, no LLM call involved", () => {
    const result = buildToolFromForm({
      name: "check_inventory",
      method: "GET",
      url: "https://api.store.com/stock",
      extract: "quantity",
    });

    expect(result.success).toBe(true);
    expect(result.tool).toEqual({
      name: "check_inventory",
      action: "http_request",
      method: "GET",
      url: "https://api.store.com/stock",
      extract: "quantity",
    });
  });

  it("rejects an invalid HTTP method", () => {
    const result = buildToolFromForm({ name: "x", method: "FETCH", url: "https://example.com" });

    expect(result.success).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it("rejects a missing name", () => {
    const result = buildToolFromForm({ name: "", method: "GET", url: "https://example.com" });

    expect(result.success).toBe(false);
  });
});
