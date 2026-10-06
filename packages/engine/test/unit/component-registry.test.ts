import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ComponentResolutionError,
  DirectoryComponentRegistry,
  InProcessModuleRunner,
} from "../../src/component-registry.js";
import { invokeOp } from "../../src/component.js";
import { ToolCallError } from "../../src/http-tool.js";

// KAN-1884 (ADR-0029): resolving id@version to a manifest by digest, and running module entries
// in-process behind the ModuleRunner interface.

const REST = (version = "1.0.0") => `kind: rest
id: acme/echo
version: ${version}
permissions: { egress: [echo.example.test] }
ops:
  ping:
    effect: read
    request:
      method: GET
      url: https://echo.example.test/ping
`;

const MODULE = (version = "1.0.0", entry = "./index.mjs") => `kind: module
id: acme/mod
version: ${version}
entry: ${entry}
permissions: { egress: [api.example.test] }
auth:
  slots:
    token: { env: MOD_TOKEN, hosts: [api.example.test], inject: { header: Authorization, template: "Bearer {{ secret }}" } }
ops:
  greet:
    effect: read
    input:
      type: object
      properties: { who: { type: string } }
`;

let root: string;
const put = (rel: string, content: string) => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kampong-registry-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("DirectoryComponentRegistry", () => {
  it("resolves an exact id@version and reports a stable digest", async () => {
    put("echo/component.yaml", REST());
    const registry = new DirectoryComponentRegistry(root);
    const a = await registry.resolve("acme/echo", "1.0.0");
    const b = await registry.resolve("acme/echo", "1.0.0");
    expect(a.manifest.id).toBe("acme/echo");
    expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.digest).toBe(a.digest);
  });

  it("keeps several versions of one component apart", async () => {
    put("echo-1/component.yaml", REST("1.0.0"));
    put("echo-2/component.yaml", REST("2.0.0"));
    const registry = new DirectoryComponentRegistry(root);
    expect((await registry.resolve("acme/echo", "2.0.0")).manifest.version).toBe("2.0.0");
    expect((await registry.resolve("acme/echo", "1.0.0")).manifest.version).toBe("1.0.0");
    expect((await registry.list()).map((c) => `${c.id}@${c.version}`).sort()).toEqual([
      "acme/echo@1.0.0",
      "acme/echo@2.0.0",
    ]);
  });

  it("fails visibly for an unknown component or version, naming what exists", async () => {
    put("echo/component.yaml", REST());
    const registry = new DirectoryComponentRegistry(root);
    await expect(registry.resolve("acme/echo", "9.9.9")).rejects.toThrow(/acme\/echo@1\.0\.0/);
    await expect(registry.resolve("acme/none", "1.0.0")).rejects.toBeInstanceOf(
      ComponentResolutionError,
    );
  });

  it("does not silently skip an invalid manifest: resolving it reports the parse errors", async () => {
    put("bad/component.yaml", "kind: rest\nid: Not Valid\nversion: 1\n");
    put("echo/component.yaml", REST());
    const registry = new DirectoryComponentRegistry(root);
    expect(await registry.problems()).toHaveLength(1);
    // Other components still resolve; the broken one is reported, not hidden.
    await expect(registry.resolve("acme/echo", "1.0.0")).resolves.toBeDefined();
    expect((await registry.problems())[0]!.message).toMatch(/bad/);
  });

  it("refuses two manifests that claim the same id@version", async () => {
    put("a/component.yaml", REST());
    put("b/component.yaml", REST());
    const registry = new DirectoryComponentRegistry(root);
    await expect(registry.resolve("acme/echo", "1.0.0")).rejects.toThrow(/more than one/);
  });

  it("checks an expected digest and refuses a mismatch", async () => {
    put("echo/component.yaml", REST());
    const registry = new DirectoryComponentRegistry(root);
    const { digest } = await registry.resolve("acme/echo", "1.0.0");
    await expect(
      registry.resolve("acme/echo", "1.0.0", { expectedDigest: digest }),
    ).resolves.toBeDefined();
    await expect(
      registry.resolve("acme/echo", "1.0.0", { expectedDigest: `sha256:${"0".repeat(64)}` }),
    ).rejects.toThrow(/digest/);
  });

  it("re-reads the disk: a manifest edited after first use changes the digest and fails a pin", async () => {
    const file = put("echo/component.yaml", REST());
    const registry = new DirectoryComponentRegistry(root);
    const { digest } = await registry.resolve("acme/echo", "1.0.0");
    writeFileSync(file, REST().replace("/ping", "/pong"));
    await expect(
      registry.resolve("acme/echo", "1.0.0", { expectedDigest: digest }),
    ).rejects.toThrow(/digest/);
  });

  it("covers every file in the component directory, not just the manifest", async () => {
    put("mod/component.yaml", MODULE());
    put("mod/index.mjs", "export async function invoke() { return 1; }");
    put("mod/helper.mjs", "export const x = 1;");
    const registry = new DirectoryComponentRegistry(root);
    const before = (await registry.resolve("acme/mod", "1.0.0")).digest;
    writeFileSync(join(root, "mod/helper.mjs"), "export const x = 2;");
    expect((await registry.resolve("acme/mod", "1.0.0")).digest).not.toBe(before);
  });

  it("refuses a symlink inside a component directory", async () => {
    put("mod/component.yaml", MODULE());
    put("mod/index.mjs", "export async function invoke() { return 1; }");
    const outside = mkdtempSync(join(tmpdir(), "kampong-outside-"));
    writeFileSync(join(outside, "secret.mjs"), "export const x = 1;");
    symlinkSync(join(outside, "secret.mjs"), join(root, "mod/linked.mjs"));
    const registry = new DirectoryComponentRegistry(root);
    await expect(registry.resolve("acme/mod", "1.0.0")).rejects.toThrow(/symlink/);
    rmSync(outside, { recursive: true, force: true });
  });

  it("does not follow a symlinked directory out of the components root when scanning", async () => {
    const outside = mkdtempSync(join(tmpdir(), "kampong-outside-"));
    mkdirSync(join(outside, "echo"));
    writeFileSync(join(outside, "echo/component.yaml"), REST());
    symlinkSync(join(outside, "echo"), join(root, "linked"));
    const registry = new DirectoryComponentRegistry(root);
    await expect(registry.resolve("acme/echo", "1.0.0")).rejects.toBeInstanceOf(
      ComponentResolutionError,
    );
    rmSync(outside, { recursive: true, force: true });
  });

  it("an empty or missing components directory resolves nothing, without crashing", async () => {
    const registry = new DirectoryComponentRegistry(join(root, "nope"));
    expect(await registry.list()).toEqual([]);
    await expect(registry.resolve("acme/echo", "1.0.0")).rejects.toBeInstanceOf(
      ComponentResolutionError,
    );
  });

  it("an rest component runs end to end through invokeOp", async () => {
    put("echo/component.yaml", REST());
    const registry = new DirectoryComponentRegistry(root);
    const { manifest } = await registry.resolve("acme/echo", "1.0.0");
    const out = await invokeOp(
      manifest,
      "ping",
      {},
      {
        fetchImpl: async () => new Response(JSON.stringify({ pong: true })),
      },
    );
    expect(out).toEqual({ pong: true });
  });
});

describe("InProcessModuleRunner", () => {
  const ENTRY = `export async function invoke(op, input, ctx) {
  if (op === "greet") return { hello: input.who ?? "world" };
  throw new Error("unknown op " + op);
}`;

  async function run(entrySource: string, input: Record<string, unknown> = { who: "kai" }) {
    put("mod/component.yaml", MODULE());
    put("mod/index.mjs", entrySource);
    const registry = new DirectoryComponentRegistry(root);
    const { manifest } = await registry.resolve("acme/mod", "1.0.0");
    return invokeOp(manifest, "greet", input, {
      runner: new InProcessModuleRunner(registry),
      env: { MOD_TOKEN: "tok-123" },
      fetchImpl: async () => new Response(JSON.stringify({ ok: true })),
    });
  }

  it("calls the entry's invoke(op, input, ctx)", async () => {
    expect(await run(ENTRY)).toEqual({ hello: "kai" });
  });

  it("fails visibly when the entry has no invoke export", async () => {
    await expect(run("export const nope = 1;")).rejects.toThrow(/invoke/);
  });

  it("fails visibly when the entry file is missing", async () => {
    put("mod/component.yaml", MODULE());
    const registry = new DirectoryComponentRegistry(root);
    await expect(registry.resolve("acme/mod", "1.0.0")).rejects.toThrow(/entry/);
  });

  it("rejects a TypeScript entry with a clear message instead of failing obscurely", async () => {
    put("mod/component.yaml", MODULE("1.0.0", "./index.ts"));
    put("mod/index.ts", "export async function invoke() { return 1; }");
    const registry = new DirectoryComponentRegistry(root);
    const { manifest } = await registry.resolve("acme/mod", "1.0.0");
    await expect(
      invokeOp(manifest, "greet", {}, { runner: new InProcessModuleRunner(registry) }),
    ).rejects.toThrow(/\.js|\.mjs/);
  });

  it("picks up a changed entry (no stale module cache) and checks the digest each call", async () => {
    expect(await run(ENTRY)).toEqual({ hello: "kai" });
    writeFileSync(
      join(root, "mod/index.mjs"),
      `export async function invoke() { return { hello: "changed" }; }`,
    );
    const registry = new DirectoryComponentRegistry(root);
    const { manifest } = await registry.resolve("acme/mod", "1.0.0");
    expect(
      await invokeOp(manifest, "greet", {}, { runner: new InProcessModuleRunner(registry) }),
    ).toEqual({ hello: "changed" });
  });

  it("refuses to run when the component changed after it was pinned", async () => {
    put("mod/component.yaml", MODULE());
    put("mod/index.mjs", ENTRY);
    const registry = new DirectoryComponentRegistry(root);
    const pinned = await registry.resolve("acme/mod", "1.0.0");
    const runner = new InProcessModuleRunner(registry, { [`acme/mod@1.0.0`]: pinned.digest });
    writeFileSync(join(root, "mod/index.mjs"), `export async function invoke() { return "evil"; }`);
    await expect(invokeOp(pinned.manifest, "greet", {}, { runner })).rejects.toThrow(/digest/);
  });

  it("gives the module the egress-checked ctx and env-backed secrets", async () => {
    const out = await run(`export async function invoke(op, input, ctx) {
  const token = ctx.secrets.get("token");
  const res = await ctx.fetch("https://api.example.test/x", { headers: { Authorization: "Bearer " + token } });
  const blocked = await ctx.fetch("https://evil.example.test/x").then(() => "reached", (e) => e.message);
  return { status: res.status, blocked };
}`);
    expect(out).toMatchObject({ status: 200 });
    expect((out as { blocked: string }).blocked).toMatch(/egress/);
  });

  it("wraps a throwing module in a visible, secret-scrubbed ToolCallError", async () => {
    const err = await run(
      `export async function invoke(op, input, ctx) { throw new Error("boom " + ctx.secrets.get("token")); }`,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ToolCallError);
    expect(String(err.message)).toMatch(/boom/);
    expect(String(err.message)).not.toContain("tok-123");
  });
});
