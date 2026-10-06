import { describe, expect, it } from "vitest";
import { parseComponentManifest } from "../../src/component.js";
import {
  diffPermissions,
  describePermissions,
  permissionsOf,
  scanModuleSources,
} from "../../src/permissions.js";

// KAN-1835 (ADR-0026, ADR-0031): the permission manifest. egress and slot hosts were enforced by the
// op-call pipeline since part A; this adds the env, fs and exec declarations, a summary/diff a reviewer
// can read, and a static check that a module's code stays inside what its manifest declares.

const MODULE = (permissions = "{ egress: [api.example.test] }", extra = "") => `kind: module
id: acme/mod
version: 1.0.0
entry: ./index.mjs
permissions: ${permissions}
${extra}ops:
  run:
    effect: read
`;

const parse = (text: string) => parseComponentManifest(text);

describe("permissions schema", () => {
  it("accepts env, fs and exec on a module", () => {
    const result = parse(
      MODULE("{ egress: [api.example.test], env: [TZ, LOG_LEVEL], fs: [read], exec: false }"),
    );
    expect(result.errors).toEqual([]);
    expect(result.manifest?.permissions).toMatchObject({ env: ["TZ", "LOG_LEVEL"], fs: ["read"] });
  });

  it("lets a module that makes no network call omit egress", () => {
    expect(parse(MODULE("{}")).errors).toEqual([]);
    expect(parse(MODULE("{ fs: [read] }")).errors).toEqual([]);
  });

  it.each([
    ["an env name that is not a variable name", "{ env: [not-a-name] }"],
    ["a duplicate env name", "{ env: [TZ, TZ] }"],
    ["an unknown fs mode", "{ fs: [execute] }"],
    ["a duplicate fs mode", "{ fs: [read, read] }"],
    ["an unknown permission", "{ network: true }"],
  ])("rejects %s", (_n, permissions) => {
    expect(parse(MODULE(permissions)).success).toBe(false);
  });

  it("rejects an env permission that names a secret slot's variable (secrets only through the slot)", () => {
    const text = MODULE(
      "{ egress: [api.example.test], env: [MY_TOKEN] }",
      "auth:\n  slots:\n    token: { env: MY_TOKEN, hosts: [api.example.test] }\n",
    );
    const errors = parse(text)
      .errors.map((e) => e.message)
      .join(" ");
    expect(errors).toMatch(/secret slot/);
  });

  const REST = (permissions: string) => `kind: rest
id: acme/rest
version: 1.0.0
permissions: ${permissions}
ops:
  get:
    effect: read
    request: { method: GET, url: "https://api.example.test/x" }
`;

  it("keeps requiring a rest component to declare egress", () => {
    expect(parse(REST("{ egress: [api.example.test] }")).errors).toEqual([]);
    expect(parse(REST("{}")).success).toBe(false);
    expect(parse(REST("{ egress: [] }")).success).toBe(false);
  });

  it.each([
    "{ egress: [api.example.test], env: [TZ] }",
    "{ egress: [api.example.test], fs: [read] }",
    "{ egress: [api.example.test], exec: true }",
  ])("a rest component runs no code, so it cannot declare env, fs or exec: %s", (permissions) => {
    const message = parse(REST(permissions))
      .errors.map((e) => e.message)
      .join(" ");
    expect(message).toMatch(/runs no code/);
  });
});

describe("permissionsOf and describePermissions", () => {
  it("normalises into a sorted, complete record so two spellings of the same grant compare equal", () => {
    const a = parse(
      MODULE("{ egress: [b.example.test, a.example.test], env: [Z, A], fs: [write, read] }"),
    ).manifest!;
    const b = parse(
      MODULE("{ egress: [a.example.test, b.example.test], env: [A, Z], fs: [read, write] }"),
    ).manifest!;
    expect(permissionsOf(a)).toEqual(permissionsOf(b));
    expect(permissionsOf(a)).toEqual({
      egress: ["a.example.test", "b.example.test"],
      env: ["A", "Z"],
      fs: ["read", "write"],
      exec: false,
      slots: {},
    });
  });

  it("includes each secret slot with the hosts it is bound to", () => {
    const m = parse(
      MODULE(
        "{ egress: [api.example.test, other.example.test] }",
        "auth:\n  slots:\n    token: { env: T, hosts: [other.example.test, api.example.test] }\n",
      ),
    ).manifest!;
    expect(permissionsOf(m).slots).toEqual({ token: ["api.example.test", "other.example.test"] });
  });

  it("describes a grant in words a reviewer can read, and says none for an empty one", () => {
    const m = parse(MODULE("{ egress: [api.example.test], fs: [read], exec: true }")).manifest!;
    expect(describePermissions(permissionsOf(m))).toBe(
      "egress: api.example.test; fs: read; exec: yes",
    );
    expect(describePermissions(permissionsOf(parse(MODULE("{}")).manifest!))).toBe(
      "no permissions",
    );
  });
});

describe("diffPermissions", () => {
  const p = (text: string) => permissionsOf(parse(text).manifest!);

  it("reports nothing when the grant is unchanged or narrower", () => {
    const before = p(MODULE("{ egress: [a.example.test, b.example.test], fs: [read, write] }"));
    expect(diffPermissions(before, before)).toEqual([]);
    expect(diffPermissions(before, p(MODULE("{ egress: [a.example.test], fs: [read] }")))).toEqual(
      [],
    );
  });

  it("reports every widening: a new host, env name, fs mode, exec, or a secret slot reaching a new host", () => {
    const before = p(
      MODULE(
        "{ egress: [a.example.test, b.example.test] }",
        "auth:\n  slots:\n    t: { env: T, hosts: [a.example.test] }\n",
      ),
    );
    const after = p(
      MODULE(
        "{ egress: [a.example.test, b.example.test, c.example.test], env: [TZ], fs: [write], exec: true }",
        "auth:\n  slots:\n    t: { env: T, hosts: [a.example.test, b.example.test] }\n    u: { env: U, hosts: [c.example.test] }\n",
      ),
    );
    expect(diffPermissions(before, after)).toEqual([
      "egress adds c.example.test",
      "env adds TZ",
      "fs adds write",
      "exec is now allowed",
      "secret slot t now reaches b.example.test",
      "new secret slot u reaches c.example.test",
    ]);
  });
});

const files = (entry: string, extra: Record<string, string> = {}) => ({
  "component.yaml": "kind: module\n",
  "index.mjs": entry,
  ...extra,
});

describe("scanModuleSources", () => {
  const manifest = (permissions = "{ egress: [api.example.test] }", extra = "") =>
    parse(MODULE(permissions, extra)).manifest as never;

  const violations = (
    source: string,
    permissions?: string,
    extra?: string,
    more?: Record<string, string>,
  ) =>
    scanModuleSources(manifest(permissions, extra), files(source, more)).map(
      (v) => `${v.file}:${v.line} ${v.capability}`,
    );

  it("accepts a module that only uses its ctx", () => {
    expect(
      violations(`import { createHash } from "node:crypto";
export async function invoke(op, input, ctx) {
  const token = ctx.secrets.get("token");
  const res = await ctx.fetch("https://api.example.test/x", { headers: { Authorization: token } });
  return { id: createHash("sha256").update(await res.text()).digest("hex"), buf: Buffer.from("x") };
}`),
    ).toEqual([]);
  });

  it.each([
    ["process.env", "const x = process.env.HOME;", "process"],
    ["process via bracket", 'const e = process["env"];', "process"],
    ["globalThis", "const g = globalThis;", "global"],
    ["global", "const g = global;", "global"],
    ["eval", "eval('1');", "eval"],
    ["indirect eval", "(0, eval)('1');", "eval"],
    ["new Function", "new Function('return 1');", "eval"],
    ["Function call", "Function('return 1')();", "eval"],
    ["constructor escape", "(async () => {}).constructor('return process')();", "eval"],
    ["require", "const f = require('fs');", "require"],
    [
      "createRequire",
      "import { createRequire } from 'node:module'; createRequire(import.meta.url);",
      "import",
    ],
    ["a computed dynamic import", "await import(name);", "import"],
    ["global fetch", "await fetch('https://x.test');", "network"],
    ["fetch captured in a variable", "const f = fetch;", "network"],
    ["XMLHttpRequest", "new XMLHttpRequest();", "network"],
    ["WebSocket", "new WebSocket('wss://x.test');", "network"],
    ["node:http", "import http from 'node:http';", "network"],
    ["https without prefix", "import https from 'https';", "network"],
    ["node:net", "import net from 'node:net';", "network"],
    ["node:dns", "import dns from 'node:dns';", "network"],
    ["child_process without exec permission", "import cp from 'node:child_process';", "exec"],
    ["worker_threads", "import w from 'node:worker_threads';", "exec"],
    ["vm", "import vm from 'node:vm';", "exec"],
    ["fs without fs permission", "import fs from 'node:fs';", "fs"],
    ["fs/promises without fs permission", "import fs from 'node:fs/promises';", "fs"],
    ["os", "import os from 'node:os';", "import"],
    ["an npm package that is not declared", "import x from 'left-pad';", "import"],
    ["a relative import that leaves the component", "import x from '../../secret.mjs';", "import"],
    ["an absolute import", "import x from '/etc/passwd';", "import"],
    ["a URL import", "import x from 'https://evil.test/x.mjs';", "network"],
    ["a data: import", "import x from 'data:text/javascript,export default 1';", "import"],
  ])("refuses %s", (_name, source, capability) => {
    const found = violations(source);
    expect(found.length, source).toBeGreaterThan(0);
    expect(
      found.some((v) => v.endsWith(` ${capability}`)),
      `${source} -> ${found}`,
    ).toBe(true);
  });

  it("allows fs and exec only when the manifest declares them", () => {
    expect(violations("import fs from 'node:fs';", "{ fs: [read] }")).toEqual([]);
    expect(violations("import cp from 'node:child_process';", "{ exec: true }")).toEqual([]);
    expect(violations("import fs from 'node:fs';", "{ exec: true }")).not.toEqual([]);
  });

  it("allows a declared npm dependency and a sibling file, and scans the sibling too", () => {
    expect(
      violations(
        "import x from 'left-pad'; import y from './helper.mjs';",
        undefined,
        "deps:\n  left-pad: 1.3.0\n",
        {
          "helper.mjs": "export const y = 1;",
        },
      ),
    ).toEqual([]);
    expect(
      violations("import y from './helper.mjs';", undefined, undefined, {
        "helper.mjs": "export const e = process.env;",
      }),
    ).toEqual(["helper.mjs:1 process"]);
  });

  it("ignores a forbidden word in a comment or a string, and reports the line of a real use", () => {
    expect(
      violations(`// never use process.env or eval( here
/* fetch( is not allowed:
   require('x') */
const message = "process.env is forbidden; fetch(url) too";
const t = \`eval(\${1})\`;
`),
    ).toEqual([]);
    expect(violations("const a = 1;\n\nconst b = process.cwd();\n")).toEqual([
      "index.mjs:3 process",
    ]);
  });

  it("does not take ctx.fetch or a property called fetch for the global", () => {
    expect(
      violations(
        "export async function invoke(o, i, ctx) { return ctx.fetch('https://api.example.test'); }",
      ),
    ).toEqual([]);
    expect(violations("const api = { fetch: 1 }; api.fetch;")).toEqual([]);
  });

  it("checks every JavaScript file in the component and ignores other files", () => {
    expect(
      violations("export const a = 1;", undefined, undefined, {
        "notes.md": "process.env eval( fetch(",
        "data.json": '{"process": "env"}',
        "nested/deep.js": "const x = eval('1');",
      }),
    ).toEqual(["nested/deep.js:1 eval"]);
  });
});
