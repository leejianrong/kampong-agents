import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleFixtureOutcome, ModuleFixtureSeam } from "./component.js";
import { redactString } from "./redact.js";
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

/** The start of a module fixture's file name; distinct from an HTTP fixture's so `kampong doctor` can tell them apart. */
export function moduleFixtureFilePrefix(toolName: string): string {
  return `module.${fixtureFilePrefix(toolName)}`;
}

function pathFor(fixturesDir: string, toolName: string, op: string, input: string): string {
  const key = createHash("sha256")
    .update(`module::${toolName}::${op}::${input}`)
    .digest("hex")
    .slice(0, 16);
  return join(fixturesDir, `${moduleFixtureFilePrefix(toolName)}${key}.json`);
}

/** Redacts object keys as well as values: a secret used as a key must not reach the file. */
function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        redactString(key, secrets),
        redactDeep(entry, secrets),
      ]),
    );
  }
  return value;
}

export function createModuleFixtures(options: CreateModuleFixturesOptions): ModuleFixtureSeam {
  const { mode, fixturesDir, secrets: configured = [] } = options;
  // What a later step would see: JSON. Dropping `undefined`s and turning a Date into text also keeps the
  // key stable; a value JSON cannot hold is an error, not a silent collision.
  const normalise = (input: Record<string, unknown>, secrets: readonly string[]): string => {
    let plain: unknown;
    try {
      plain = JSON.parse(JSON.stringify(input));
    } catch (err) {
      throw new Error(
        `the input of a module op must be JSON to be recorded: ${(err as Error).message}`,
        { cause: err },
      );
    }
    return redactString(canonicalJson(plain), secrets);
  };
  return {
    mode,
    replay(toolName, op, input) {
      const path = pathFor(fixturesDir, toolName, op, normalise(input, configured));
      if (!existsSync(path)) throw new MissingFixtureError(toolName, path, true);
      return (JSON.parse(readFileSync(path, "utf8")) as ModuleFixtureFile).outcome;
    },
    record(toolName, op, input, outcome, used) {
      // The key is made without the secrets the module read, because a replay has no credentials and
      // cannot know them; they are redacted from what is written, not from what it is filed under.
      const path = pathFor(fixturesDir, toolName, op, normalise(input, configured));
      const secrets = [...configured, ...used];
      const file: ModuleFixtureFile = {
        kind: "module",
        toolName,
        op,
        input: normalise(input, secrets),
        outcome: redactDeep(outcome, secrets) as ModuleFixtureOutcome,
      };
      mkdirSync(fixturesDir, { recursive: true });
      writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    },
  };
}
