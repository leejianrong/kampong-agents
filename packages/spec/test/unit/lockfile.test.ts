import { describe, expect, it } from "vitest";
import { parseLockfile, serializeLockfile, LOCKFILE_NAME } from "../../src/lockfile.js";

// KAN-1834 (ADR-0025/0026): kampong.lock pins each component id@version to a content digest.

const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;

describe("kampong.lock", () => {
  it("is named kampong.lock", () => {
    expect(LOCKFILE_NAME).toBe("kampong.lock");
  });

  it("round-trips, sorted, with a trailing newline", () => {
    const text = serializeLockfile({
      version: 1,
      components: { "kampong/slack@1.0.0": { digest: D2 }, "acme/echo@2.0.0": { digest: D1 } },
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf("acme/echo@2.0.0")).toBeLessThan(text.indexOf("kampong/slack@1.0.0"));
    const parsed = parseLockfile(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.lockfile?.components["acme/echo@2.0.0"]?.digest).toBe(D1);
    expect(serializeLockfile(parsed.lockfile!)).toBe(text);
  });

  it("serialises the same content identically regardless of insertion order", () => {
    const a = serializeLockfile({
      version: 1,
      components: { "a/x@1.0.0": { digest: D1 }, "b/y@1.0.0": { digest: D2 } },
    });
    const b = serializeLockfile({
      version: 1,
      components: { "b/y@1.0.0": { digest: D2 }, "a/x@1.0.0": { digest: D1 } },
    });
    expect(a).toBe(b);
  });

  it.each([
    ["a range", "acme/echo@^1.0.0"],
    ["no version", "acme/echo"],
    ["a tag", "acme/echo@latest"],
  ])("rejects a key with %s (no mutable tags)", (_n, key) => {
    const text = `version: 1\ncomponents:\n  "${key}":\n    digest: ${D1}\n`;
    expect(parseLockfile(text).success).toBe(false);
  });

  it.each([
    ["a short digest", "sha256:abc"],
    ["another algorithm", `sha512:${"a".repeat(64)}`],
    ["upper-case hex", `sha256:${"A".repeat(64)}`],
    ["no prefix", "a".repeat(64)],
  ])("rejects %s", (_n, digest) => {
    const text = `version: 1\ncomponents:\n  acme/echo@1.0.0:\n    digest: ${digest}\n`;
    expect(parseLockfile(text).success).toBe(false);
  });

  it("rejects an unknown version, unknown fields and malformed YAML without throwing", () => {
    expect(parseLockfile(`version: 2\ncomponents: {}\n`).success).toBe(false);
    expect(
      parseLockfile(
        `version: 1\ncomponents:\n  acme/echo@1.0.0:\n    digest: ${D1}\n    extra: 1\n`,
      ).success,
    ).toBe(false);
    expect(parseLockfile("version: [\n").success).toBe(false);
    expect(parseLockfile("").success).toBe(false);
  });

  it("accepts an empty components map", () => {
    expect(parseLockfile(`version: 1\ncomponents: {}\n`).success).toBe(true);
  });

  it("does not let a key like __proto__ pollute or resolve inherited values", () => {
    const text = `version: 1\ncomponents:\n  "__proto__/x@1.0.0":\n    digest: ${D1}\n`;
    const parsed = parseLockfile(text);
    expect(({} as Record<string, unknown>)["digest"]).toBeUndefined();
    expect(parsed.success).toBe(false);
  });

  it("returns errors, never throws, for a YAML alias or anchor", () => {
    const text = `version: 1\ncomponents:\n  acme/echo@1.0.0: &a\n    digest: ${D1}\n  acme/other@1.0.0: *a\n`;
    expect(() => parseLockfile(text)).not.toThrow();
    expect(parseLockfile(text).success).toBe(false);
  });

  it("records the permissions a component was reviewed with, and round-trips them", () => {
    const text = serializeLockfile({
      version: 1,
      components: {
        "acme/echo@1.0.0": {
          digest: D1,
          permissions: {
            egress: ["a.example.test"],
            env: [],
            fs: ["read"],
            exec: false,
            slots: { token: ["a.example.test"] },
            slotEnv: { token: "T" },
          },
        },
      },
    });
    expect(text).toContain("a.example.test");
    const parsed = parseLockfile(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.lockfile?.components["acme/echo@1.0.0"]?.permissions?.fs).toEqual(["read"]);
    expect(parsed.lockfile?.components["acme/echo@1.0.0"]?.permissions?.slotEnv).toEqual({
      token: "T",
    });
    expect(serializeLockfile(parsed.lockfile!)).toBe(text);
  });

  it("still reads an entry that has no permissions record", () => {
    const parsed = parseLockfile(
      `version: 1\ncomponents:\n  acme/echo@1.0.0:\n    digest: ${D1}\n`,
    );
    expect(parsed.success).toBe(true);
    expect(parsed.lockfile?.components["acme/echo@1.0.0"]?.permissions).toBeUndefined();
  });

  it.each([
    ["an unknown fs mode", "fs: [execute]"],
    ["a non-boolean exec", "exec: maybe"],
    ["an unknown field", "network: true"],
    ["slots that are not lists", "slots: { t: a.example.test }"],
  ])("rejects a permissions record with %s", (_n, line) => {
    const text = `version: 1\ncomponents:\n  acme/echo@1.0.0:\n    digest: ${D1}\n    permissions:\n      egress: []\n      env: []\n      fs: []\n      exec: false\n      slots: {}\n      ${line}\n`;
    expect(parseLockfile(text).success).toBe(false);
  });
});
