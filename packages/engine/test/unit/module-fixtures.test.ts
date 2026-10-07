import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseComponentManifest, type ModuleComponentManifest } from "@kampong/spec";
import { invokeOp, type ModuleRunner } from "../../src/component.js";
import { ToolCallError } from "../../src/http-tool.js";
import { createModuleFixtures } from "../../src/module-fixtures.js";
import { MissingFixtureError } from "../../src/tool-fixtures.js";

// KAN-1833 (ADR-0034): record and replay at the invoke(op, input) boundary, so a module that does not
// speak HTTP is as deterministic as one that does.

const MANIFEST = parseComponentManifest(`kind: module
id: acme/db
version: 1.0.0
entry: ./index.mjs
permissions: { egress: [db.example.test] }
auth:
  slots:
    token: { env: DB_TOKEN, hosts: [db.example.test] }
ops:
  query:
    effect: read
    input: { type: object, required: [sql], properties: { sql: { type: string }, params: { type: array } } }
    output: { type: object, required: [rows], properties: { rows: { type: array } } }
`).manifest as ModuleComponentManifest;

const runnerReturning = (fn: ModuleRunner["invoke"]): ModuleRunner & { calls: number } => {
  const runner = {
    calls: 0,
    invoke: async (...args: Parameters<ModuleRunner["invoke"]>) => {
      runner.calls += 1;
      return fn(...args);
    },
  };
  return runner;
};

describe("module fixtures", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-module-fixtures-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const record = () => createModuleFixtures({ mode: "record", fixturesDir: dir });
  const replay = () => createModuleFixtures({ mode: "replay", fixturesDir: dir });

  it("replays a recorded result without running the module, needing a runner, or a credential", async () => {
    const live = runnerReturning(async () => ({ rows: [{ id: 1 }] }));
    const recorded = await invokeOp(
      MANIFEST,
      "query",
      { sql: "select 1" },
      { runner: live, moduleFixtures: record(), env: { DB_TOKEN: "t" } },
    );
    expect(live.calls).toBe(1);

    // No runner, no env: nothing runs, so nothing is needed.
    const replayed = await invokeOp(
      MANIFEST,
      "query",
      { sql: "select 1" },
      { moduleFixtures: replay(), env: {} },
    );
    expect(replayed).toEqual(recorded);
    expect(live.calls).toBe(1);
  });

  it("keys on the input, so two calls differing in one field do not share a fixture", async () => {
    const live = runnerReturning(async (_m, _op, input) => ({ rows: [input.sql] }));
    for (const sql of ["a", "b"]) {
      await invokeOp(MANIFEST, "query", { sql }, { runner: live, moduleFixtures: record() });
    }
    expect(readdirSync(dir)).toHaveLength(2);
    const first = await invokeOp(MANIFEST, "query", { sql: "a" }, { moduleFixtures: replay() });
    const second = await invokeOp(MANIFEST, "query", { sql: "b" }, { moduleFixtures: replay() });
    expect([first, second]).toEqual([{ rows: ["a"] }, { rows: ["b"] }]);
  });

  it("does not care about the order of keys in the input", async () => {
    const live = runnerReturning(async () => ({ rows: [] }));
    await invokeOp(
      MANIFEST,
      "query",
      { sql: "s", params: [1] },
      { runner: live, moduleFixtures: record() },
    );
    await expect(
      invokeOp(MANIFEST, "query", { params: [1], sql: "s" }, { moduleFixtures: replay() }),
    ).resolves.toEqual({ rows: [] });
  });

  it("is a MissingFixtureError, never a live call, when nothing was recorded", async () => {
    const live = runnerReturning(async () => ({ rows: [] }));
    const err = await invokeOp(
      MANIFEST,
      "query",
      { sql: "never recorded" },
      { runner: live, moduleFixtures: replay() },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(MissingFixtureError);
    expect(err.message).toContain("acme/db.query");
    expect(live.calls).toBe(0);
  });

  it("records and replays what the module threw, keeping its status", async () => {
    const live = runnerReturning(async () => {
      throw Object.assign(new Error("relation does not exist"), { status: 404 });
    });
    const first = await invokeOp(
      MANIFEST,
      "query",
      { sql: "x" },
      { runner: live, moduleFixtures: record() },
    ).catch((e) => e);
    const second = await invokeOp(
      MANIFEST,
      "query",
      { sql: "x" },
      { moduleFixtures: replay() },
    ).catch((e) => e);
    expect(second).toBeInstanceOf(ToolCallError);
    expect(second.message).toBe(first.message);
    expect(second.code).toBe(first.code);
    expect(second.cause.message).toBe("relation does not exist");
    expect(second.cause.status).toBe(404);
  });

  it("redacts the secrets a module read from the file, and still finds it when the secret rotates", async () => {
    const live = runnerReturning(async (_m, _op, _input, ctx) => {
      const token = ctx.secrets.get("token");
      return { rows: [`connected with ${token}`] };
    });
    await invokeOp(
      MANIFEST,
      "query",
      { sql: "s" },
      { runner: live, moduleFixtures: record(), env: { DB_TOKEN: "hunter2-secret" } },
    );
    const file = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(file).not.toContain("hunter2-secret");
    expect(
      await invokeOp(MANIFEST, "query", { sql: "s" }, { moduleFixtures: replay() }),
    ).toMatchObject({ rows: [expect.stringContaining("connected with")] });
  });

  it("redacts a secret that appears in the input", async () => {
    const live = runnerReturning(async (_m, _op, _input, ctx) => {
      ctx.secrets.get("token");
      return { rows: [] };
    });
    await invokeOp(
      MANIFEST,
      "query",
      { sql: "select 'hunter2-secret'" },
      { runner: live, moduleFixtures: record(), env: { DB_TOKEN: "hunter2-secret" } },
    );
    expect(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8")).not.toContain("hunter2-secret");
  });

  it("does not record a refusal by the pipeline, which depends on where it ran", async () => {
    const live = runnerReturning(async (_m, _op, _input, ctx) => {
      await ctx.fetch("https://elsewhere.example.test/");
      return { rows: [] };
    });
    await invokeOp(
      MANIFEST,
      "query",
      { sql: "s" },
      { runner: live, moduleFixtures: record() },
    ).catch(() => undefined);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves a call that names its own tool (the legacy kinds) on the HTTP-level fixtures", async () => {
    const live = runnerReturning(async () => ({ rows: [] }));
    await invokeOp(
      MANIFEST,
      "query",
      { sql: "s" },
      { runner: live, moduleFixtures: replay(), toolName: "legacy_tool" },
    );
    expect(live.calls).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("records nothing and changes nothing when no fixtures are configured", async () => {
    const live = runnerReturning(async () => ({ rows: [1] }));
    await invokeOp(MANIFEST, "query", { sql: "s" }, { runner: live }).catch(() => undefined);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("validates a replayed result against the declared output like a live one", async () => {
    const live = runnerReturning(async () => ({ rows: [] }));
    await invokeOp(MANIFEST, "query", { sql: "s" }, { runner: live, moduleFixtures: record() });
    // The component's output contract tightened since the recording.
    const stricter = parseComponentManifest(
      `kind: module
id: acme/db
version: 1.0.0
entry: ./index.mjs
ops:
  query:
    effect: read
    input: { type: object, required: [sql], properties: { sql: { type: string }, params: { type: array } } }
    output: { type: object, required: [count], properties: { count: { type: number } } }
`,
    ).manifest as ModuleComponentManifest;
    await expect(
      invokeOp(stricter, "query", { sql: "s" }, { moduleFixtures: replay() }),
    ).rejects.toThrow(/did not match the declared output/);
  });

  it("an op that returns nothing replays as nothing", async () => {
    const noOutput = parseComponentManifest(
      `kind: module
id: acme/db
version: 1.0.0
entry: ./index.mjs
ops:
  ping: { effect: read, input: { type: object } }
`,
    ).manifest as ModuleComponentManifest;
    const live = runnerReturning(async () => undefined);
    await invokeOp(noOutput, "ping", {}, { runner: live, moduleFixtures: record() });
    expect(await invokeOp(noOutput, "ping", {}, { moduleFixtures: replay() })).toBeUndefined();
  });

  it("does not record an error that says nothing about why it failed (a refused connection, a bad import)", async () => {
    const live = runnerReturning(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    });
    await invokeOp(
      MANIFEST,
      "query",
      { sql: "s" },
      { runner: live, moduleFixtures: record() },
    ).catch(() => undefined);
    expect(readdirSync(dir)).toEqual([]);
    // ...nor one a module made out of a refusal by the pipeline.
    const rethrows = runnerReturning(async (_m, _op, _input, ctx) => {
      try {
        await ctx.fetch("https://elsewhere.example.test/");
      } catch (err) {
        throw new Error(`wrapped: ${(err as Error).message}`, { cause: err });
      }
      return { rows: [] };
    });
    await invokeOp(
      MANIFEST,
      "query",
      { sql: "s" },
      { runner: rethrows, moduleFixtures: record() },
    ).catch(() => undefined);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a failure to record is not reported as the module's failure, and writes no failure fixture", async () => {
    const live = runnerReturning(async () => ({ rows: [], big: 10n }));
    const err = await invokeOp(
      MANIFEST,
      "query",
      { sql: "s" },
      { runner: live, moduleFixtures: record() },
    ).catch((e) => e);
    expect(err.message).toContain("cannot be recorded");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("finds a fixture when a secret the module read is also in the input, because the key is made without it", async () => {
    const live = runnerReturning(async (_m, _op, _input, ctx) => {
      ctx.secrets.get("token");
      return { rows: [] };
    });
    const input = { sql: "select 'hunter2-secret'" };
    await invokeOp(MANIFEST, "query", input, {
      runner: live,
      moduleFixtures: record(),
      env: { DB_TOKEN: "hunter2-secret" },
    });
    const file = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(file).not.toContain("hunter2-secret");
    await expect(invokeOp(MANIFEST, "query", input, { moduleFixtures: replay() })).resolves.toEqual(
      {
        rows: [],
      },
    );
  });

  it("redacts a secret used as a key, and a declared env variable the module echoes", async () => {
    const withEnv = parseComponentManifest(`kind: module
id: acme/db
version: 1.0.0
entry: ./index.mjs
permissions: { env: [REGION] }
ops:
  query: { effect: read, input: { type: object } }
`).manifest as ModuleComponentManifest;
    const live = runnerReturning(async (_m, _op, _input, ctx) => ({
      "key-hunter2-secret": ctx.env.get("REGION"),
    }));
    await invokeOp(
      withEnv,
      "query",
      {},
      {
        runner: live,
        moduleFixtures: createModuleFixtures({
          mode: "record",
          fixturesDir: dir,
          secrets: ["hunter2-secret"],
        }),
        env: { REGION: "env-token-value" },
      },
    );
    const file = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(file).not.toContain("hunter2-secret");
    expect(file).not.toContain("env-token-value");
  });

  it("returns from a recording run what a replay will, so both validate the same value", async () => {
    const live = runnerReturning(async () => ({ rows: [], when: new Date(0) }));
    const result = (await invokeOp(
      MANIFEST,
      "query",
      { sql: "s" },
      { runner: live, moduleFixtures: record() },
    )) as { when: unknown };
    expect(result.when).toBe("1970-01-01T00:00:00.000Z");
  });

  it("keys the same whether an input has an undefined field or leaves it out", async () => {
    const live = runnerReturning(async () => ({ rows: [] }));
    await invokeOp(
      MANIFEST,
      "query",
      { sql: "s", params: undefined },
      { runner: live, moduleFixtures: record() },
    );
    await expect(
      invokeOp(MANIFEST, "query", { sql: "s" }, { moduleFixtures: replay() }),
    ).resolves.toEqual({ rows: [] });
  });
});
