import { describe, expect, it } from "vitest";
import { parseComponentManifest, type ModuleComponentManifest } from "@kampong/spec";
import { invokeOp, type ModuleRunner } from "../../src/component.js";
import { ToolCallError } from "../../src/http-tool.js";
import type { Clock } from "../../src/pacing.js";

// A module op can opt in to retries; the engine retries what the module says is safe to repeat.

const manifest = (retry = "retry: { max: 2, backoff: fixed, base_ms: 10, max_delay_ms: 1000 }") =>
  parseComponentManifest(`kind: module
id: acme/svc
version: 1.0.0
entry: ./index.mjs
ops:
  read: { effect: read, ${retry} }
  write: { effect: write, ${retry} }
  plain: { effect: read }
`).manifest as ModuleComponentManifest;

function failing(
  failures: unknown[],
  result: unknown = { ok: true },
): ModuleRunner & { calls: number } {
  const runner = {
    calls: 0,
    invoke: async () => {
      const failure = failures[runner.calls];
      runner.calls += 1;
      if (failure !== undefined) throw failure;
      return result;
    },
  };
  return runner;
}

const err = (message: string, props: object) => Object.assign(new Error(message), props);

function clock(): Clock & { slept: number[] } {
  const slept: number[] = [];
  return { slept, now: () => 0, sleep: async (ms) => void slept.push(ms) };
}

describe("module op retry", () => {
  it("retries a read op after a 503 and returns the eventual result", async () => {
    const runner = failing([err("down", { status: 503 })]);
    const c = clock();
    await expect(invokeOp(manifest(), "read", {}, { runner, clock: c })).resolves.toEqual({
      ok: true,
    });
    expect(runner.calls).toBe(2);
    expect(c.slept).toEqual([10]);
  });

  it("does not retry a write op after a 503, which may already have been processed", async () => {
    const runner = failing([err("down", { status: 503 })]);
    const e = await invokeOp(manifest(), "write", {}, { runner, clock: clock() }).catch((x) => x);
    expect(e).toBeInstanceOf(ToolCallError);
    expect(e.status).toBe(503);
    expect(runner.calls).toBe(1);
  });

  it("retries a write op after a 429, which the server refused before acting", async () => {
    const runner = failing([err("slow down", { status: 429 })]);
    await expect(invokeOp(manifest(), "write", {}, { runner, clock: clock() })).resolves.toEqual({
      ok: true,
    });
    expect(runner.calls).toBe(2);
  });

  it("honours a module that says retryable: true, and waits as long as it asked", async () => {
    const runner = failing([
      err("secondary limit", { status: 403, retryable: true, retryAfterMs: 400 }),
    ]);
    const c = clock();
    await invokeOp(manifest(), "write", {}, { runner, clock: c });
    expect(c.slept).toEqual([400]);
  });

  it("does not retry an op that declares no retry policy", async () => {
    const runner = failing([err("down", { status: 503 })]);
    await expect(invokeOp(manifest(), "plain", {}, { runner, clock: clock() })).rejects.toThrow();
    expect(runner.calls).toBe(1);
  });

  it("does not retry an error with no status, such as a refused connection or a bug", async () => {
    const runner = failing([new Error("connect ECONNREFUSED")]);
    await expect(invokeOp(manifest(), "read", {}, { runner, clock: clock() })).rejects.toThrow();
    expect(runner.calls).toBe(1);
  });

  it("gives up after max retries and says how many attempts it made", async () => {
    const down = err("down", { status: 503 });
    const runner = failing([down, down, down, down]);
    const e = await invokeOp(manifest(), "read", {}, { runner, clock: clock() }).catch((x) => x);
    expect(runner.calls).toBe(3);
    expect(e.message).toContain("after 3 attempts");
    expect(e.status).toBe(503);
  });

  it("does not wait past max_delay_ms when the server asks for longer", async () => {
    const runner = failing([err("limited", { status: 429, retryAfterMs: 60_000 })]);
    const c = clock();
    const e = await invokeOp(manifest(), "read", {}, { runner, clock: c }).catch((x) => x);
    expect(e.message).toContain("longer than max_delay_ms 1000ms; not retrying");
    expect(runner.calls).toBe(1);
    expect(c.slept).toEqual([]);
  });

  it("backs off exponentially when asked", async () => {
    const down = err("down", { status: 500 });
    const runner = failing([down, down]);
    const c = clock();
    await invokeOp(
      manifest("retry: { max: 3, backoff: exponential, base_ms: 10 }"),
      "read",
      {},
      { runner, clock: c },
    );
    expect(c.slept).toEqual([10, 20]);
  });

  it("reports an error's status and kind: 429 is a rate limit and retryable, 404 is neither", async () => {
    const limited = await invokeOp(
      manifest(),
      "plain",
      {},
      { runner: failing([err("x", { status: 429 })]) },
    ).catch((x) => x);
    expect([limited.code, limited.retryable, limited.status]).toEqual(["rate_limit", true, 429]);
    const missing = await invokeOp(
      manifest(),
      "plain",
      {},
      { runner: failing([err("x", { status: 404 })]) },
    ).catch((x) => x);
    expect([missing.code, missing.retryable, missing.status]).toEqual(["http", false, 404]);
  });

  it("never retries a refusal by the pipeline", async () => {
    const runner = failing([new ToolCallError("host not allowed", "permission", false, 403)]);
    await expect(invokeOp(manifest(), "read", {}, { runner, clock: clock() })).rejects.toThrow(
      /host not allowed/,
    );
    expect(runner.calls).toBe(1);
  });

  it("does not run the module again once the call was cancelled during the wait", async () => {
    const controller = new AbortController();
    const runner = failing([err("slow down", { status: 429 })]);
    const c: Clock = {
      now: () => 0,
      sleep: async () => controller.abort(), // cancelled while backing off
    };
    const e = await invokeOp(
      manifest(),
      "write",
      {},
      { runner, clock: c, signal: controller.signal },
    ).catch((x) => x);
    expect(e).toBeInstanceOf(ToolCallError);
    expect(e.code).toBe("timeout");
    expect(runner.calls).toBe(1);
  });

  it("ignores a retryAfterMs that is not a usable number", async () => {
    const runner = failing([err("x", { status: 429, retryAfterMs: Number.NaN })]);
    const c = clock();
    await invokeOp(manifest(), "read", {}, { runner, clock: c });
    expect(c.slept).toEqual([10]);
  });
});
