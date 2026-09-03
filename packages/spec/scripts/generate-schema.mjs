// Regenerates the published JSON Schema artifact from the Zod schema
// (PLAN.md Shape S7, ADR-0008). Run via `npm run generate:schema` in this
// package whenever schema.ts changes — CI does not regenerate it, so a
// stale checked-in artifact would silently drift from the Zod source of
// truth; the "schema matches current fixtures" unit test is what catches
// that if someone forgets.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateAgentSpecJsonSchema, agentSpecJsonSchemaFilename } from "../dist/json-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "schemas");
mkdirSync(outDir, { recursive: true });

const schema = generateAgentSpecJsonSchema();
const outPath = join(outDir, agentSpecJsonSchemaFilename());
writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`);

console.log(`Wrote ${outPath}`);
