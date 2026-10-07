import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleFixtureOutcome, ModuleFixtureSeam } from "./component.js";
import { mapStringsDeep, redactString } from "./redact.js";
import { canonicalJson, fixtureFilePrefix, MissingFixtureError } from "./tool-fixtures.js";

// Record/replay at the connector boundary (KAN-1833, ADR-0034). A `kind: module` component runs code, and
// that code may talk to something that is not HTTP (IMAP, Postgres, an embeddings library), so the fetch
// seam in tool-fixtures.ts cannot make it deterministic. This records what `invoke(op, input)` returned
// or threw and, on replay, hands that back without running the module: no code, no network and no
// credentials. It is keyed on the tool name, the op and the input, so two calls that differ only in their
// body cannot share a fixture. A replay with no recorded outcome is a MissingFixtureError, never a live call.

export interface CreateModuleFixturesOptions {
  mode: "record" | "replay";
  /** The same directory the HTTP fixtures live in; file names do not collide. */
  fixturesDir: string;
  /** Literal secret values to redact from anything written to a fixture file. */
  secrets?: string[];
}

interface ModuleFixtureFile {
  kind: "module";
  toolName: string;
  op: string;
  /** Redacted, canonical-JSON input: what the key was made from. */
  input: string;
  outcome: ModuleFixtureOutcome;
}

function pathFor(fixturesDir: string, toolName: string, op: string, input: string): string {
  const key = createHash("sha256")
    .update(`module::${toolName}::${op}::${input}`)
    .digest("hex")
    .slice(0, 16);
  return join(fixturesDir, `${fixtureFilePrefix(toolName)}${key}.json`);
}

export function createModuleFixtures(options: CreateModuleFixturesOptions): ModuleFixtureSeam {
  const { mode, fixturesDir, secrets: configured = [] } = options;
  const normalise = (input: Record<string, unknown>, secrets: readonly string[]): string =>
    redactString(canonicalJson(input), secrets);
  return {
    mode,
    replay(toolName, op, input) {
      const path = pathFor(fixturesDir, toolName, op, normalise(input, configured));
      if (!existsSync(path)) throw new MissingFixtureError(toolName, path, true);
      return (JSON.parse(readFileSync(path, "utf8")) as ModuleFixtureFile).outcome;
    },
    record(toolName, op, input, outcome, used) {
      const secrets = [...configured, ...used];
      const redacted = mapStringsDeep(outcome, (text) =>
        redactString(text, secrets),
      ) as ModuleFixtureOutcome;
      const file: ModuleFixtureFile = {
        kind: "module",
        toolName,
        op,
        input: normalise(input, secrets),
        outcome: redacted,
      };
      mkdirSync(fixturesDir, { recursive: true });
      writeFileSync(
        pathFor(fixturesDir, toolName, op, file.input),
        `${JSON.stringify(file, null, 2)}\n`,
      );
    },
  };
}
