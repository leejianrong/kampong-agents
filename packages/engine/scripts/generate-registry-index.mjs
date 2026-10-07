// Regenerates components/registry-index.json from the first-party components on disk (KAN-1838). Run via
// `npm run generate:registry-index` in this package after adding or changing a first-party component. A
// revocation recorded in the existing file is carried over, including for a version no longer on disk, so
// regenerating never silently un-revokes anything. The registry-index test fails if the file is stale.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createFirstPartyRegistry, shippedRegistryIndexPath } from "../dist/index.js";
import { parseRegistryIndex, serializeRegistryIndex } from "@kampong/spec";

const path = shippedRegistryIndexPath();
const previous = existsSync(path)
  ? parseRegistryIndex(readFileSync(path, "utf8")).index
  : undefined;
const { components, problems } = await createFirstPartyRegistry().resolveAll();
if (problems.length > 0) {
  console.error(`first-party components failed to load:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
const entries = components.map(({ manifest, digest }) => {
  const old = previous?.components.find(
    (c) => c.id === manifest.id && c.version === manifest.version && c.digest === digest,
  );
  return {
    id: manifest.id,
    version: manifest.version,
    digest,
    tier: 0,
    ...(old?.revoked && { revoked: old.revoked }),
  };
});
// Keep a revoked entry whose files are gone or changed: that is the record of what must not run.
for (const old of previous?.components ?? []) {
  if (
    old.revoked &&
    !entries.some((e) => e.id === old.id && e.version === old.version && e.digest === old.digest)
  ) {
    entries.push(old);
  }
}
writeFileSync(path, serializeRegistryIndex({ version: 1, components: entries }));
console.log(`Wrote ${path} (${entries.length} entries)`);
