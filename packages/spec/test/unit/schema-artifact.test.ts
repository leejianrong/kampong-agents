import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentSpecJsonSchemaFilename, generateAgentSpecJsonSchema } from "../../src/json-schema.js";

// The checked-in artifact under schemas/ is what external editors/agentic
// tools actually read via the yaml-language-server pragma (ADR-0008) — it's
// generated, not hand-written, so it can silently drift from schema.ts if
// someone edits the Zod schema and forgets `npm run generate:schema`. This
// test is the guard.
describe("checked-in JSON Schema artifact", () => {
  it("matches what generateAgentSpecJsonSchema() produces right now", () => {
    const path = fileURLToPath(
      new URL(`../../schemas/${agentSpecJsonSchemaFilename()}`, import.meta.url),
    );
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk).toEqual(generateAgentSpecJsonSchema());
  });
});
