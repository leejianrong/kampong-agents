import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRegistryIndex, type RegistryIndex } from "@kampong/spec";
import {
  createFirstPartyRegistry,
  DirectoryComponentRegistry,
} from "../../src/component-registry.js";
import {
  loadRevocations,
  PROJECT_REGISTRY_INDEX,
  RevocationRegistry,
  RevokedComponentError,
  shippedRegistryIndexPath,
} from "../../src/revocation.js";

// KAN-1838: revocation in the registry index, honoured wherever a component is resolved.

const MANIFEST = `kind: module
id: acme/x
version: 1.0.0
entry: ./index.mjs
ops:
  go: { effect: read }
`;

describe("RevocationRegistry", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-revocation-"));
    mkdirSync(join(dir, "components/acme/x/1.0.0"), { recursive: true });
    writeFileSync(join(dir, "components/acme/x/1.0.0/component.yaml"), MANIFEST);
    writeFileSync(
      join(dir, "components/acme/x/1.0.0/index.mjs"),
      "export async function invoke() {}\n",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const inner = () => new DirectoryComponentRegistry(join(dir, "components"));
  const digest = async () => (await inner().resolve("acme/x", "1.0.0")).digest;
  const indexRevoking = (d: string, extra = {}): RegistryIndex => ({
    version: 1,
    components: [
      {
        id: "acme/x",
        version: "1.0.0",
        digest: d,
        tier: 2,
        revoked: { reason: "steals tokens", at: "2026-10-07", ...extra },
      },
    ],
  });

  it("refuses the revoked bytes, saying why, when and where to read more", async () => {
    const d = await digest();
    const registry = new RevocationRegistry(inner(), () => [
      indexRevoking(d, { advisory: "https://example.com/adv" }),
    ]);
    const err = await registry.resolve("acme/x", "1.0.0").catch((e) => e);
    expect(err).toBeInstanceOf(RevokedComponentError);
    expect(err.message).toContain("acme/x@1.0.0 was revoked on 2026-10-07: steals tokens");
    expect(err.message).toContain("https://example.com/adv");
  });

  it("lets through the same version with different bytes, and an entry that is not revoked", async () => {
    const other = `sha256:${"0".repeat(64)}`;
    const registry = new RevocationRegistry(inner(), () => [indexRevoking(other)]);
    expect((await registry.resolve("acme/x", "1.0.0")).manifest.id).toBe("acme/x");
    const clean = new RevocationRegistry(inner(), () => [
      { version: 1, components: [{ id: "acme/x", version: "1.0.0", digest: other, tier: 2 }] },
    ]);
    expect((await clean.resolve("acme/x", "1.0.0")).manifest.id).toBe("acme/x");
  });

  it("reads the source on every resolve, so a new revocation applies to the next call", async () => {
    const d = await digest();
    let indexes: RegistryIndex[] = [];
    const registry = new RevocationRegistry(inner(), () => indexes);
    await registry.resolve("acme/x", "1.0.0");
    indexes = [indexRevoking(d)];
    await expect(registry.resolve("acme/x", "1.0.0")).rejects.toBeInstanceOf(RevokedComponentError);
  });

  it("does not hide a component that cannot be found behind a revocation check", async () => {
    const registry = new RevocationRegistry(inner(), () => []);
    await expect(registry.resolve("acme/none", "1.0.0")).rejects.toThrow(/not found/);
  });

  it("lists what the inner registry lists", async () => {
    const registry = new RevocationRegistry(inner(), () => []);
    expect((await registry.list()).map((c) => c.id)).toEqual(["acme/x"]);
  });
});

describe("loadRevocations", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-revocations-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const D = `sha256:${"c".repeat(64)}`;
  const writeLocal = (text: string) => {
    mkdirSync(join(dir, ".kampong"), { recursive: true });
    writeFileSync(join(dir, PROJECT_REGISTRY_INDEX), text);
  };

  it("is only the shipped index when the project has none", () => {
    expect(loadRevocations(dir)).toHaveLength(1);
  });

  it("adds a project index's revocations and nothing else: it can take trust away but never grant it", () => {
    writeLocal(
      JSON.stringify({
        version: 1,
        components: [
          { id: "acme/y", version: "1.0.0", digest: D, tier: 0 },
          {
            id: "acme/z",
            version: "1.0.0",
            digest: D,
            tier: 0,
            revoked: { reason: "bad", at: "2026-10-07" },
          },
        ],
      }),
    );
    const indexes = loadRevocations(dir);
    expect(indexes).toHaveLength(2);
    expect(indexes[1]!.components.map((c) => c.id)).toEqual(["acme/z"]);
  });

  it("fails rather than ignores a project index it cannot read, which would hide a revocation", () => {
    writeLocal("{ not json");
    expect(() => loadRevocations(dir)).toThrow(/this project's registry index .* is not valid/);
    writeLocal(JSON.stringify({ version: 1, components: [{ id: "x" }] }));
    expect(() => loadRevocations(dir)).toThrow(/is not valid/);
  });
});

describe("the registry index shipped with kampong", () => {
  const shipped = parseRegistryIndex(readFileSync(shippedRegistryIndexPath(), "utf8"));

  it("is valid", () => {
    expect(shipped.errors).toEqual([]);
  });

  it("lists every first-party component on disk at tier 0 with the digest it has now (run `npm run generate:registry-index` in packages/engine after changing one)", async () => {
    const { components } = await createFirstPartyRegistry().resolveAll();
    const listed = new Set(
      shipped.index!.components.map((c) => `${c.id}@${c.version}:${c.digest}:${c.tier}`),
    );
    for (const { manifest, digest } of components) {
      expect(
        listed.has(`${manifest.id}@${manifest.version}:${digest}:0`),
        `${manifest.id}@${manifest.version}`,
      ).toBe(true);
    }
  });

  it("revokes none of the components that ship today", async () => {
    const { components } = await createFirstPartyRegistry().resolveAll();
    const registry = new RevocationRegistry(createFirstPartyRegistry(), () =>
      loadRevocations(tmpdir()),
    );
    for (const { manifest } of components) {
      await expect(registry.resolve(manifest.id, manifest.version)).resolves.toBeDefined();
    }
  });
});
