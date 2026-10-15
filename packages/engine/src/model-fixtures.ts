import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  StructuredOutputError,
  type GenerateStructuredInput,
  type GenerateTextInput,
  type ModelClient,
} from "./model.js";
import { redactDeep } from "./module-fixtures.js";
import { redactString } from "./redact.js";
import { canonicalJson } from "./tool-fixtures.js";

// Record/replay at the ModelClient boundary (KAM-156, ADR-0051). Tool and connector calls already replay from
// fixtures; a model call did not, so a spec with a model step was offline only with a local Ollama or an
// injected client. This wraps a ModelClient: in "record" it makes the real call and files the answer, and in
// "replay" it answers from the file and never reaches a provider, so a replay needs neither network nor key.
//
// The key is the kind of call (text or structured), the instructions, the prompt, the step's model override and
// its temperature, so two steps whose prompts differ cannot share an answer, and a changed prompt is a miss
// rather than a stale reply. A replay with no recorded answer is a MissingModelFixtureError, never a live call.
// The step's output schema is not part of the key: a structured answer is parsed against the schema on replay,
// so a schema that changed under a recorded answer fails by name instead of returning the wrong shape.
//
// Only an answer is recorded, and one failure that is the model's own: a structured answer that broke its
// schema, because the workflow shows that to the model and asks again, and a replay must retrace the retry.
// A timeout or an unreachable server is the environment's, so it is never recorded.

/** The start of a model fixture's file name. `@` cannot appear in a tool's file prefix, so it cannot collide. */
export const MODEL_FIXTURE_PREFIX = "@model.";

export class MissingModelFixtureError extends Error {
  constructor(
    public readonly fixturePath: string,
    public readonly step: string,
  ) {
    super(
      `No recorded model fixture at ${fixturePath} for ${step}. Run once with \`--tools record\` (or ` +
        "`--model record`) against a live model to create it. A replay never falls back to a live call, and a " +
        "changed prompt, instruction, model or temperature needs re-recording.",
    );
    this.name = "MissingModelFixtureError";
  }
}

export interface CreateModelFixturesOptions {
  mode: "record" | "replay";
  /** The same directory the tool fixtures live in; file names do not collide. */
  fixturesDir: string;
  /** The real client to record from. Required for "record"; unused, and never called, for "replay". */
  inner?: ModelClient;
  /** Literal secret values to redact from anything written to a fixture file. */
  secrets?: string[];
}

type ModelOutcome =
  | { value: unknown }
  | { error: { name: "StructuredOutputError"; message: string; problems: string[]; raw: unknown } };

interface ModelFixtureFile {
  kind: "model";
  call: "text" | "structured";
  /** Redacted, canonical JSON: what the key was made from. */
  request: string;
  outcome: ModelOutcome;
}

type CallInput = GenerateTextInput | GenerateStructuredInput<unknown>;

export function createModelFixtures(options: CreateModelFixturesOptions): ModelClient {
  const { mode, fixturesDir, inner, secrets = [] } = options;
  if (mode === "record" && !inner) {
    throw new Error("createModelFixtures: record mode needs the real model client to record from.");
  }

  const describe = (call: "text" | "structured", input: CallInput): string =>
    `the ${call} model call "${input.prompt.slice(0, 60).replace(/\s+/g, " ")}${input.prompt.length > 60 ? "..." : ""}"`;

  const locate = (call: "text" | "structured", input: CallInput) => {
    const request = redactString(
      canonicalJson({
        call,
        instructions: input.instructions,
        prompt: input.prompt,
        model: input.model ?? null,
        temperature: input.temperature ?? null,
      }),
      secrets,
    );
    const key = createHash("sha256").update(request).digest("hex").slice(0, 16);
    return { request, path: join(fixturesDir, `${MODEL_FIXTURE_PREFIX}${call}.${key}.json`) };
  };

  const write = (path: string, file: ModelFixtureFile): void => {
    mkdirSync(fixturesDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(redactDeep(file, secrets), null, 2)}\n`);
  };

  const read = (call: "text" | "structured", input: CallInput) => {
    const { path } = locate(call, input);
    if (!existsSync(path)) throw new MissingModelFixtureError(path, describe(call, input));
    return { path, file: JSON.parse(readFileSync(path, "utf8")) as ModelFixtureFile };
  };

  return {
    async generateText(input) {
      if (mode === "replay") {
        const { path, file } = read("text", input);
        if (!("value" in file.outcome) || typeof file.outcome.value !== "string") {
          throw new Error(`Model fixture ${path} is not a text answer; re-record it.`);
        }
        return file.outcome.value;
      }
      const value = await inner!.generateText(input);
      const { request, path } = locate("text", input);
      write(path, { kind: "model", call: "text", request, outcome: { value } });
      return value;
    },

    async generateStructured<T>(input: GenerateStructuredInput<T>): Promise<T> {
      if (mode === "replay") {
        const { path, file } = read("structured", input);
        if ("error" in file.outcome) {
          const { message, problems, raw } = file.outcome.error;
          throw new StructuredOutputError(message, problems, raw);
        }
        const parsed = input.schema.safeParse(file.outcome.value);
        if (!parsed.success) {
          throw new Error(
            `Model fixture ${path} no longer matches this step's output schema (${parsed.error.message}); ` +
              "re-record it.",
          );
        }
        return parsed.data;
      }
      const { request, path } = locate("structured", input);
      try {
        const value = await inner!.generateStructured(input);
        write(path, { kind: "model", call: "structured", request, outcome: { value } });
        return value;
      } catch (err) {
        if (err instanceof StructuredOutputError) {
          write(path, {
            kind: "model",
            call: "structured",
            request,
            outcome: {
              error: {
                name: "StructuredOutputError",
                message: err.message,
                problems: err.problems,
                raw: err.raw,
              },
            },
          });
        }
        throw err;
      }
    },
  };
}
