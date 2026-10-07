import { describe, expect, it } from "vitest";
import {
  findRevocation,
  parseRevocations,
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

describe("a revocation of every build of a version", () => {
  const entry = {
    id: "acme/x",
    version: "1.0.0",
    tier: 2,
    revoked: { reason: "r", at: "2026-10-07" },
  };

  it("needs no digest, and matches any files claiming that id@version", () => {
    const parsed = parseRegistryIndex(index([entry]));
    expect(parsed.errors).toEqual([]);
    expect(findRevocation([parsed.index!], "acme/x", "1.0.0", D1)).toBeDefined();
    expect(findRevocation([parsed.index!], "acme/x", "1.0.0", D2)).toBeDefined();
    expect(findRevocation([parsed.index!], "acme/x", "1.0.1", D1)).toBeUndefined();
  });

  it("is only for a revocation: an ordinary entry still needs its digest", () => {
    const { revoked: _revoked, ...plain } = entry;
    void _revoked;
    expect(
      parseRegistryIndex(index([plain]))
        .errors.map((e) => e.message)
        .join(" "),
    ).toMatch(/needs a digest/);
  });

  it("round-trips without inventing a digest", () => {
    const text = serializeRegistryIndex(parseRegistryIndex(index([entry])).index!);
    expect(text).not.toContain("digest");
    expect(parseRegistryIndex(text).errors).toEqual([]);
  });
});

describe("a revocation's advisory link", () => {
  const withAdvisory = (advisory: string) =>
    parseRegistryIndex(
      index([
        {
          id: "a/b",
          version: "1.0.0",
          digest: D1,
          tier: 0,
          revoked: { reason: "r", at: "2026-10-07", advisory },
        },
      ]),
    );
  it("must be https", () => {
    expect(withAdvisory("https://example.com/a").errors).toEqual([]);
    for (const bad of ["javascript:alert(1)", "http://example.com/a", "data:text/html,x"]) {
      expect(withAdvisory(bad).index, bad).toBeUndefined();
    }
  });
});

describe("parseRevocations (an index nobody has verified)", () => {
  const ok = {
    id: "acme/z",
    version: "1.0.0",
    digest: D1,
    tier: 2,
    revoked: { reason: "bad", at: "2026-10-07" },
  };

  it("returns only the revoked entries", () => {
    const parsed = parseRevocations(
      JSON.stringify({
        version: 1,
        components: [{ id: "acme/y", version: "1.0.0", digest: D2, tier: 0 }, ok],
      }),
    );
    expect(parsed.revocations?.components.map((c) => c.id)).toEqual(["acme/z"]);
  });

  it("is not stopped by what it does not understand in an entry that is not a revocation", () => {
    const parsed = parseRevocations(
      JSON.stringify({
        version: 1,
        components: [{ id: "NOT VALID", tier: 99, future_field: true }, "garbage", ok],
      }),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.revocations?.components).toHaveLength(1);
  });

  it("is an error when an entry that claims a revocation is not valid, so it cannot be silently skipped", () => {
    const parsed = parseRevocations(
      JSON.stringify({
        version: 1,
        components: [{ ...ok, revoked: { reason: "", at: "yesterday" } }],
      }),
    );
    expect(parsed.revocations).toBeUndefined();
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("is an error for a format version it does not know, naming it, and for text that is not an index", () => {
    expect(
      parseRevocations(JSON.stringify({ version: 2, components: [] })).errors[0]!.message,
    ).toMatch(/unknown index version 2/);
    expect(parseRevocations("{").errors[0]!.message).toMatch(/not valid JSON/);
    expect(parseRevocations("[]").errors).toHaveLength(1);
    expect(parseRevocations(JSON.stringify({ version: 1 })).errors).toHaveLength(1);
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
