import { describe, expect, it } from "vitest";
import {
  findRevocation,
  parseRegistryIndex,
  serializeRegistryIndex,
  type RegistryIndex,
} from "../../src/registry-index.js";

// KAN-1838: the registry index and its revocation field.

const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;

const index = (components: unknown[]) => JSON.stringify({ version: 1, components });

describe("parseRegistryIndex", () => {
  it("accepts entries with and without a revocation", () => {
    const parsed = parseRegistryIndex(
      index([
        { id: "kampong/slack", version: "1.0.0", digest: D1, tier: 0 },
        {
          id: "acme/x",
          version: "2.0.0",
          digest: D2,
          tier: 2,
          revoked: {
            reason: "exfiltrates mail",
            at: "2026-10-07",
            advisory: "https://example.com/a",
          },
        },
      ]),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.index?.components).toHaveLength(2);
  });

  it.each([
    ["not JSON", "{", /not valid JSON/],
    ["an unknown version", JSON.stringify({ version: 2, components: [] }), /expected 1/],
    [
      "an unknown field",
      index([{ id: "a/b", version: "1.0.0", digest: D1, tier: 0, extra: 1 }]),
      /extra|Unrecognized/i,
    ],
    [
      "a bad digest",
      index([{ id: "a/b", version: "1.0.0", digest: "sha256:abc", tier: 0 }]),
      /sha256/,
    ],
    ["a bad tier", index([{ id: "a/b", version: "1.0.0", digest: D1, tier: 3 }]), /./],
    [
      "a range as a version",
      index([{ id: "a/b", version: "^1.0.0", digest: D1, tier: 0 }]),
      /exact version/,
    ],
    [
      "a revocation with no reason",
      index([{ id: "a/b", version: "1.0.0", digest: D1, tier: 0, revoked: { at: "2026-10-07" } }]),
      /./,
    ],
    [
      "a revocation with a bad date",
      index([
        {
          id: "a/b",
          version: "1.0.0",
          digest: D1,
          tier: 0,
          revoked: { reason: "x", at: "yesterday" },
        },
      ]),
      /date/,
    ],
    [
      "the same entry twice",
      index([
        { id: "a/b", version: "1.0.0", digest: D1, tier: 0 },
        { id: "a/b", version: "1.0.0", digest: D1, tier: 0 },
      ]),
      /twice/,
    ],
  ])("rejects %s", (_name, text, message) => {
    const parsed = parseRegistryIndex(text);
    expect(parsed.index).toBeUndefined();
    expect(parsed.errors.map((e) => e.message).join(" ")).toMatch(message);
  });
});

describe("findRevocation", () => {
  const revoked = { reason: "malicious update", at: "2026-10-07" };
  const idx: RegistryIndex = {
    version: 1,
    components: [
      { id: "acme/x", version: "1.0.0", digest: D1, tier: 2, revoked },
      { id: "acme/x", version: "1.0.1", digest: D2, tier: 2 },
    ],
  };

  it("matches the revoked bytes of that version", () => {
    expect(findRevocation([idx], "acme/x", "1.0.0", D1)).toEqual(revoked);
  });

  it("does not match a different digest, a different version, or an entry that is not revoked", () => {
    expect(findRevocation([idx], "acme/x", "1.0.0", D2)).toBeUndefined();
    expect(findRevocation([idx], "acme/x", "1.0.1", D2)).toBeUndefined();
    expect(findRevocation([idx], "acme/y", "1.0.0", D1)).toBeUndefined();
  });

  it("finds a revocation in any of several indexes", () => {
    const clean: RegistryIndex = { version: 1, components: [] };
    expect(findRevocation([clean, idx], "acme/x", "1.0.0", D1)).toEqual(revoked);
  });
});

describe("serializeRegistryIndex", () => {
  it("is deterministic and round-trips", () => {
    const a: RegistryIndex = {
      version: 1,
      components: [
        { id: "b/b", version: "1.0.0", digest: D2, tier: 0 },
        {
          id: "a/a",
          version: "1.0.0",
          digest: D1,
          tier: 0,
          revoked: { reason: "r", at: "2026-10-07" },
        },
      ],
    };
    const text = serializeRegistryIndex(a);
    expect(serializeRegistryIndex({ ...a, components: [...a.components].reverse() })).toBe(text);
    expect(parseRegistryIndex(text).index?.components.map((c) => c.id)).toEqual(["a/a", "b/b"]);
  });
});
