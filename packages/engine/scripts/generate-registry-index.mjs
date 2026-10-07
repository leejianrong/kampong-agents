// Regenerates components/registry-index.json from the first-party components on disk (KAN-1838). Run via
// `npm run generate:registry-index` in this package after adding or changing a first-party component. A
// revocation recorded in the existing file is carried over (see mergeShippedIndex), so regenerating never
// silently un-revokes anything; a file that exists but does not parse stops the script rather than being
// treated as having no revocations. The registry-index test fails if the file is stale.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createFirstPartyRegistry,
  mergeShippedIndex,
  shippedRegistryIndexPath,
} from "../dist/index.js";
import { parseRegistryIndex, serializeRegistryIndex } from "@kampong/spec";

const path = shippedRegistryIndexPath();
let previous;
if (existsSync(path)) {
  const parsed = parseRegistryIndex(readFileSync(path, "utf8"));
  if (!parsed.index) {
    console.error(
      `${path} exists but is not valid, so its revocations cannot be carried over. Fix it first:\n  ` +
        parsed.errors.map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`).join("\n  "),
    );
    process.exit(1);
  }
  previous = parsed.index;
}
const { components, problems } = await createFirstPartyRegistry().resolveAll();
if (problems.length > 0) {
  console.error(`first-party components failed to load:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
const merged = mergeShippedIndex(
  previous,
  components.map(({ manifest, digest }) => ({
    id: manifest.id,
    version: manifest.version,
    digest,
  })),
);
writeFileSync(path, serializeRegistryIndex(merged));
console.log(`Wrote ${path} (${merged.components.length} entries)`);
