import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentRun, type ModelClient } from "@kampong/engine";
import { parseSpec } from "@kampong/spec";
import {
  EXIT_EXECUTION_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  EXIT_VALIDATION_FAILURE,
  runCli,
} from "../../src/cli.js";
import { createServeServer } from "../../src/serve-server.js";
import { capture } from "../unit/test-helpers.js";

// KAN-1840: a version 1.1 spec validates (expressions and vars are checked), but cannot run or export until
// the evaluator lands (KAN-1841, KAN-1851). The refusal is by name and the exit codes are the usual ones.

const model: ModelClient = {
  async generateText() {
    return "ok";
  },
  async generateStructured<T>() {
    return { result: {}, confidence: 1 } as T;
  },
};

const SPEC = (ifExpr: string) => `version: "1.1"
vars:
  n:
    type: number
    default: 1
agent:
  id: a
  name: A
  role: R
  goal: G
  model: { provider: ollama, name: llama3.1 }
  tools:
    - name: t
      action: http_request
      method: GET
      url: "https://x.test/"
  workflow:
    - step: first
      action: classify
    - step: decide
      type: condition
      if: ${JSON.stringify(ifExpr)}
      then: "request_human_approval"
      else: "request_human_approval"
`;

describe("kampong with a version 1.1 spec", () => {
  let dir: string;
  const path = () => join(dir, "agent.yaml");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-cli-1-1-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = async (args: string[], source = SPEC("trigger.score > vars.n")) => {
    writeFileSync(path(), source);
    const { io, out, err } = capture();
    const code = await runCli(["run", path(), ...args, "--json", "--approve-all"], io, { model });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("run evaluates the expressions: the condition reads the input as the trigger and the var's default", async () => {
    const result = await run(["--input", '{"score": 3}']);
    expect(result.code, result.err + result.out).toBe(EXIT_SUCCESS);
    const json = JSON.parse(result.out);
    expect(json.status).toBe("completed");
    // 3 > 1 (the default): the condition's approval step ran and was approved.
    expect(JSON.stringify(json.trace)).toContain("decide");
  });

  it("--var overrides a var, and --header reaches trigger.headers", async () => {
    const source = SPEC("$number(trigger.headers.`x-score`) > vars.n");
    expect(
      (await run(["--input", "{}", "--header", "X-Score=9", "--var", "n=5"], source)).code,
    ).toBe(EXIT_SUCCESS);
    // Without the header the expression reads nothing: a failure, not a quiet false.
    const missing = await run(["--input", "{}"], source);
    expect(missing.code).toBe(EXIT_EXECUTION_FAILURE);
    expect(missing.out + missing.err).toMatch(/evaluated to nothing|number/);
  });

  it("run refuses a --var the spec does not declare, naming the declared ones", async () => {
    const result = await run(["--input", "{}", "--var", "nope=1"]);
    expect(result.code).toBe(EXIT_USAGE_ERROR);
    expect(result.err).toContain("--var nope is not declared in the spec's vars (declared: n)");
  });

  it("run refuses a malformed --var or --header", async () => {
    expect((await run(["--input", "{}", "--var", "novalue"])).code).toBe(EXIT_USAGE_ERROR);
    expect((await run(["--input", "{}", "--header", "=x"])).code).toBe(EXIT_USAGE_ERROR);
  });

  it("run fails with the var's name when its value is not the declared type", async () => {
    const result = await run(["--input", '{"score":1}', "--var", "n=lots"]);
    expect(result.code).toBe(EXIT_EXECUTION_FAILURE);
    expect(result.out + result.err).toContain("vars.n");
  });

  it("run reports a bad expression as a validation failure with its line, before anything runs", async () => {
    const source = SPEC("first.score > > vars.n");
    const line = source.split("\n").findIndex((l) => l.includes("if:")) + 1;
    const result = await run(["--input", "x"], source);
    expect(result.code).toBe(EXIT_VALIDATION_FAILURE);
    // With --json the errors are in the JSON object: the path, the message and the line.
    const json = JSON.parse(result.out);
    expect(json.phase).toBe("validation");
    expect(json.errors[0]).toMatchObject({ path: ["agent", "workflow", 1, "if"], line });
    expect(json.errors[0].message).toContain('condition "decide"');
  });

  it("export refuses it by name and writes nothing, until the exported entry points pass the trigger and vars", async () => {
    writeFileSync(path(), SPEC("trigger.score > vars.n"));
    const { io, err } = capture();
    const code = await runCli(["export", path(), join(dir, "out")], io);
    expect(code).not.toBe(EXIT_SUCCESS);
    expect(err.join("\n")).toContain("cannot be exported yet");
  });

  it("doctor validates it", async () => {
    writeFileSync(path(), SPEC("trigger.score > vars.n"));
    const { io } = capture();
    const code = await runCli(["doctor", path()], io, { env: {} });
    expect(code).not.toBe(EXIT_VALIDATION_FAILURE);
  });

  describe("kampong serve", () => {
    const WEBHOOK_SPEC = `version: "1.1"
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: ask
      type: approval
      message: "event={{ trigger.headers.\`x-event\` }} n={{ trigger.n }} auth={{ $exists(trigger.headers.authorization) }} cookie={{ $exists(trigger.headers.cookie) }}"
`;

    it("hands the webhook's headers and JSON body to expressions, never its credentials", async () => {
      writeFileSync(path(), WEBHOOK_SPEC);
      const app = createServeServer({ specPath: path(), run: { createModel: () => model } });
      try {
        await app.ready();
        const hook = await app.inject({
          method: "POST",
          url: "/webhook",
          headers: {
            "content-type": "application/json",
            "x-event": "push",
            authorization: "Bearer secret-token",
            cookie: "session=abc",
          },
          payload: { n: 4 },
        });
        expect(hook.statusCode).toBe(201);
        const id = hook.json().id as string;
        let text = "";
        for (let i = 0; i < 100 && !text.includes("event="); i += 1) {
          await new Promise((r) => setTimeout(r, 25));
          text = JSON.stringify((await app.inject({ method: "GET", url: `/runs/${id}` })).json());
        }
        expect(text).toContain("event=push n=4 auth=false cookie=false");
        expect(text).not.toContain("secret-token");
      } finally {
        await app.close();
      }
    });
  });

  describe("examples/incident-responder.yaml", () => {
    const source = readFileSync(
      new URL("../../../../examples/incident-responder.yaml", import.meta.url),
      "utf8",
    );

    it("is a valid 1.1 spec, and runs: deep paths, an aggregate over a list, a typed JSON body", async () => {
      const parsed = parseSpec(source);
      expect(parsed.errors).toEqual([]);
      const calls: { url: string; method: string; body?: string }[] = [];
      const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string });
        return new Response(
          JSON.stringify(
            String(url).includes("/alerts/")
              ? {
                  severity: "critical",
                  owner: { team: "sre", oncall: ["ana", "raj"] },
                  services: [
                    { name: "db", tier: 1 },
                    { name: "api", tier: 2 },
                  ],
                }
              : { paged: true },
          ),
          { status: 200 },
        );
      }) as unknown as typeof fetch;
      const run = createAgentRun(parsed.spec!, { model, fetchImpl, env: {} });
      const state = await run.start('{"alerts":[{"id":"A7"}],"change":-12}');
      expect(state.status).toBe("completed");
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        "GET https://api.example.com/alerts/A7",
        "POST https://api.example.com/page/ana?tier=1",
      ]);
      expect(JSON.parse(calls[1]!.body!)).toEqual({ team: "sre", change: 12 });
    });

    it("does not page when the change is below the threshold, and takes the override of a var", async () => {
      const parsed = parseSpec(source);
      const calls: string[] = [];
      const fetchImpl = (async (url: string | URL) => {
        calls.push(String(url));
        return new Response(
          JSON.stringify({
            severity: "critical",
            owner: { team: "t", oncall: ["x"] },
            services: [{ tier: 1 }],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;
      const run = createAgentRun(parsed.spec!, {
        model,
        fetchImpl,
        env: {},
        vars: { api: "http://local.test" },
      });
      // A small change: the condition is false, so the run waits for a person instead of paging.
      const state = await run.start('{"alerts":[{"id":"A7"}],"change":-1}');
      expect(state.status).toBe("awaiting_approval");
      expect(calls).toEqual(["http://local.test/alerts/A7"]);
    });
  });
});
