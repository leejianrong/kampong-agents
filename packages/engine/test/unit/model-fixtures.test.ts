import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createModelFixtures,
  MissingModelFixtureError,
  MODEL_FIXTURE_PREFIX,
  StructuredOutputError,
  type ModelClient,
} from "../../src/index.js";

// KAM-156: record/replay at the ModelClient boundary. A replay answers from the file and reaches no provider.

const schema = z.object({ summary: z.string(), direction: z.enum(["up", "down"]) });

function scripted(handlers: Partial<ModelClient> = {}) {
  const calls: string[] = [];
  const client: ModelClient = {
    generateText: async ({ prompt }) => (calls.push(prompt), `text:${prompt}`),
    generateStructured: async <T>({ prompt }: { prompt: string }) => {
      calls.push(prompt);
      return { summary: `s:${prompt}`, direction: "up" } as T;
    },
    ...handlers,
  };
  return { client, calls };
}
const never: ModelClient = {
  generateText: async () => {
    throw new Error("a replay reached the model");
  },
  generateStructured: async () => {
    throw new Error("a replay reached the model");
  },
};

describe("model fixtures", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "kampong-model-fixtures-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const record = (inner: ModelClient, secrets?: string[]) =>
    createModelFixtures({ mode: "record", fixturesDir: dir, inner, ...(secrets && { secrets }) });
  const replay = () => createModelFixtures({ mode: "replay", fixturesDir: dir });
  const req = { instructions: "Be brief.", prompt: "AAPL closed at 104" };

  it("records a text answer and replays it without a model", async () => {
    const { client, calls } = scripted();
    expect(await record(client).generateText(req)).toBe("text:AAPL closed at 104");
    expect(calls).toHaveLength(1);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(
      new RegExp(`^${MODEL_FIXTURE_PREFIX.replace(".", "\\.")}text\\.[0-9a-f]{16}\\.json$`),
    );
    expect(await replay().generateText(req)).toBe("text:AAPL closed at 104");
  });

  it("records a structured answer and replays it parsed against the schema", async () => {
    await record(scripted().client).generateStructured({ ...req, schema });
    expect(await replay().generateStructured({ ...req, schema })).toEqual({
      summary: "s:AAPL closed at 104",
      direction: "up",
    });
  });

  it("a miss is a MissingModelFixtureError naming the call, and never reaches a provider", async () => {
    await expect(replay().generateText(req)).rejects.toBeInstanceOf(MissingModelFixtureError);
    await expect(replay().generateText(req)).rejects.toThrow(/AAPL closed at 104/);
    // The replay client has no inner client at all, so there is nothing it could have called.
    expect(never).toBeDefined();
  });

  it.each([
    ["prompt", { prompt: "AAPL closed at 105" }],
    ["instructions", { instructions: "Be long." }],
    ["model override", { model: "other" }],
    ["temperature", { temperature: 0.9 }],
  ])("a different %s is a different call", async (_, change) => {
    await record(scripted().client).generateText(req);
    await expect(replay().generateText({ ...req, ...change })).rejects.toBeInstanceOf(
      MissingModelFixtureError,
    );
  });

  it("text and structured calls with the same prompt do not share a fixture", async () => {
    await record(scripted().client).generateText(req);
    await expect(replay().generateStructured({ ...req, schema })).rejects.toBeInstanceOf(
      MissingModelFixtureError,
    );
  });

  it("a recorded answer that no longer fits the schema fails by name instead of returning the wrong shape", async () => {
    await record(scripted().client).generateStructured({ ...req, schema });
    const stricter = z.object({
      summary: z.string(),
      direction: z.enum(["up", "down"]),
      score: z.number(),
    });
    await expect(replay().generateStructured({ ...req, schema: stricter })).rejects.toThrow(
      /no longer matches this step's output schema/,
    );
  });

  it("records a structured answer that broke its schema and replays the same error, so a retry retraces", async () => {
    const broken = new StructuredOutputError("bad", ["output.direction: Invalid option"], {
      direction: "sideways",
    });
    const inner = scripted({ generateStructured: async () => Promise.reject(broken) });
    await expect(record(inner.client).generateStructured({ ...req, schema })).rejects.toBe(broken);
    const error = await replay()
      .generateStructured({ ...req, schema })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect(error).toMatchObject({
      problems: ["output.direction: Invalid option"],
      raw: { direction: "sideways" },
    });
  });

  it("does not record an environmental failure", async () => {
    const inner = scripted({ generateText: async () => Promise.reject(new Error("timed out")) });
    await expect(record(inner.client).generateText(req)).rejects.toThrow("timed out");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("redacts a secret from what it writes and files the call under the redacted prompt", async () => {
    const secret = "sk-live-123456";
    const withSecret = { ...req, prompt: `key ${secret}` };
    await record(scripted().client, [secret]).generateText(withSecret);
    const text = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(text).not.toContain(secret);
    // A replay has no secrets to redact with, so the prompt it is given carries the placeholder it was filed under.
    const redacted = { ...req, prompt: text.includes("[REDACTED]") ? "key [REDACTED]" : "?" };
    expect(await replay().generateText(redacted)).toContain("[REDACTED]");
  });

  it("record mode needs a client", () => {
    expect(() => createModelFixtures({ mode: "record", fixturesDir: dir })).toThrow(
      /real model client/,
    );
  });
});
