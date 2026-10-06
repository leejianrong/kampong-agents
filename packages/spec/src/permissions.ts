import type { ComponentManifest, ModuleComponentManifest } from "./component.js";

// The permission model of a component (KAN-1835, ADR-0026 section 2, ADR-0031): a normalised summary a
// reviewer can read and compare, and a static check that a module's code stays inside what its
// manifest declares.
//
// What is and is not enforced is stated plainly in ADR-0031. In short: egress and secret-slot hosts are
// enforced on every request. `env` is enforced by what `ctx.env` hands out. For a module's own code,
// `scanModuleSources` is a static check that catches mistakes and unsophisticated misbehaviour; it is
// not a sandbox and does not claim to stop determined code. Real isolation is a `ModuleRunner` that is
// not in-process (ADR-0031).

export interface Permissions {
  egress: string[];
  env: string[];
  fs: ("read" | "write")[];
  exec: boolean;
  /** Each secret slot and the hosts it may be sent to. */
  slots: Record<string, string[]>;
}

const sorted = <T extends string>(items: readonly T[] | undefined): T[] =>
  [...(items ?? [])].sort();

/** The grant a manifest makes, sorted and complete, so two spellings of one grant compare equal. */
export function permissionsOf(manifest: ComponentManifest): Permissions {
  const granted = manifest.permissions;
  const slots: Record<string, string[]> = {};
  for (const name of Object.keys(manifest.auth?.slots ?? {}).sort()) {
    slots[name] = sorted(manifest.auth!.slots[name]!.hosts);
  }
  return {
    egress: sorted(granted?.egress),
    env: sorted(granted?.env),
    fs: sorted(granted?.fs),
    exec: granted?.exec === true,
    slots,
  };
}

/** One line for a reviewer, for example `egress: slack.com; fs: read`. */
export function describePermissions(permissions: Permissions): string {
  const parts: string[] = [];
  if (permissions.egress.length > 0) parts.push(`egress: ${permissions.egress.join(", ")}`);
  if (permissions.env.length > 0) parts.push(`env: ${permissions.env.join(", ")}`);
  if (permissions.fs.length > 0) parts.push(`fs: ${permissions.fs.join(", ")}`);
  if (permissions.exec) parts.push("exec: yes");
  const slots = Object.entries(permissions.slots);
  if (slots.length > 0) {
    parts.push(
      `secret slots: ${slots.map(([name, hosts]) => `${name} -> ${hosts.join(", ")}`).join("; ")}`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : "no permissions";
}

/** Every way `after` grants more than `before`. An empty list means the grant did not widen. */
export function diffPermissions(before: Permissions, after: Permissions): string[] {
  const out: string[] = [];
  for (const host of after.egress) {
    if (!before.egress.includes(host)) out.push(`egress adds ${host}`);
  }
  for (const name of after.env) {
    if (!before.env.includes(name)) out.push(`env adds ${name}`);
  }
  for (const mode of after.fs) {
    if (!before.fs.includes(mode)) out.push(`fs adds ${mode}`);
  }
  if (after.exec && !before.exec) out.push("exec is now allowed");
  for (const [name, hosts] of Object.entries(after.slots)) {
    const known = Object.hasOwn(before.slots, name) ? before.slots[name]! : undefined;
    for (const host of hosts) {
      if (known === undefined) out.push(`new secret slot ${name} reaches ${host}`);
      else if (!known.includes(host)) out.push(`secret slot ${name} now reaches ${host}`);
    }
  }
  return out;
}

// ---- Static check of a module's code ----------------------------------------------------------------------

export interface ModuleViolation {
  file: string;
  line: number;
  /** process, global, eval, require, import, network, fs or exec. */
  capability: string;
  message: string;
}

interface Blanked {
  /** Comments and the contents of strings and template text replaced by spaces; code and newlines kept. */
  code: string;
  /** Comments replaced by spaces; strings kept, so an import specifier can be read. */
  text: string;
}

/**
 * Blanks comments and string contents so a forbidden word in a comment or a message is not mistaken for
 * code, while the code inside a template's `${}` is kept. Offsets and line breaks are preserved.
 * Regular-expression literals are not recognised; one containing a quote can confuse the scan, which
 * errs toward reporting rather than hiding.
 */
function blank(source: string): Blanked {
  const code: string[] = [];
  const text: string[] = [];
  let i = 0;
  const n = source.length;
  const keepNewline = (ch: string): string => (ch === "\n" || ch === "\r" ? ch : " ");

  const scan = (untilBrace: boolean): void => {
    let depth = 0;
    while (i < n) {
      const c = source[i]!;
      const d = source[i + 1];
      if (c === "/" && d === "/") {
        while (i < n && source[i] !== "\n") {
          code.push(" ");
          text.push(" ");
          i++;
        }
        continue;
      }
      if (c === "/" && d === "*") {
        code.push(" ", " ");
        text.push(" ", " ");
        i += 2;
        while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
          code.push(keepNewline(source[i]!));
          text.push(keepNewline(source[i]!));
          i++;
        }
        if (i < n) {
          code.push(" ", " ");
          text.push(" ", " ");
          i += 2;
        }
        continue;
      }
      if (c === '"' || c === "'") {
        code.push(c);
        text.push(c);
        i++;
        while (i < n && source[i] !== c && source[i] !== "\n") {
          if (source[i] === "\\" && i + 1 < n) {
            code.push(" ", " ");
            text.push(source[i]!, source[i + 1]!);
            i += 2;
            continue;
          }
          code.push(" ");
          text.push(source[i]!);
          i++;
        }
        if (source[i] === c) {
          code.push(c);
          text.push(c);
          i++;
        }
        continue;
      }
      if (c === "`") {
        code.push("`");
        text.push("`");
        i++;
        while (i < n && source[i] !== "`") {
          if (source[i] === "\\" && i + 1 < n) {
            code.push(" ", keepNewline(source[i + 1]!));
            text.push(source[i]!, source[i + 1]!);
            i += 2;
            continue;
          }
          if (source[i] === "$" && source[i + 1] === "{") {
            code.push("$", "{");
            text.push("$", "{");
            i += 2;
            scan(true);
            continue;
          }
          code.push(keepNewline(source[i]!));
          text.push(source[i]!);
          i++;
        }
        if (source[i] === "`") {
          code.push("`");
          text.push("`");
          i++;
        }
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") {
        if (untilBrace && depth === 0) {
          code.push("}");
          text.push("}");
          i++;
          return;
        }
        depth--;
      }
      code.push(c);
      text.push(c);
      i++;
    }
  };
  scan(false);
  return { code: code.join(""), text: text.join("") };
}

const lineOf = (source: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
};

// Node built-ins by what they let code do. Anything not listed here or below is refused as `import`.
const SAFE_BUILTINS = new Set([
  "assert",
  "buffer",
  "crypto",
  "events",
  "path",
  "path/posix",
  "querystring",
  "stream",
  "stream/promises",
  "string_decoder",
  "timers",
  "timers/promises",
  "url",
  "util",
  "zlib",
]);
const NETWORK_BUILTINS = new Set([
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "dns",
  "dns/promises",
]);
const EXEC_BUILTINS = new Set(["child_process", "worker_threads", "cluster", "vm"]);
const FS_BUILTINS = new Set(["fs", "fs/promises"]);
const OTHER_BUILTINS = new Set([
  "os",
  "module",
  "process",
  "v8",
  "repl",
  "readline",
  "tty",
  "inspector",
  "async_hooks",
  "perf_hooks",
  "diagnostics_channel",
  "wasi",
  "sqlite",
  "test",
  "sea",
]);

const SOURCE_FILE = /\.(?:mjs|cjs|js)$/;

// Plain identifier uses, not `.name` property reads and not an object key `name:`.
const ident = (name: string): RegExp => new RegExp(`(?<![.\\w$])${name}\\b(?!\\s*:)`, "g");

const CODE_RULES: { pattern: RegExp; capability: string; message: string }[] = [
  {
    pattern: ident("process"),
    capability: "process",
    message: "process is not available to a module; use ctx.env and ctx.secrets",
  },
  {
    pattern: ident("globalThis"),
    capability: "global",
    message: "globalThis gives a module the host's globals",
  },
  {
    pattern: ident("global"),
    capability: "global",
    message: "global gives a module the host's globals",
  },
  { pattern: ident("eval"), capability: "eval", message: "eval is not allowed" },
  { pattern: /\bnew\s+Function\b/g, capability: "eval", message: "new Function is not allowed" },
  {
    pattern: ident("Function(?=\\s*\\()"),
    capability: "eval",
    message: "Function() is not allowed",
  },
  {
    pattern: /\.\s*constructor\s*\(/g,
    capability: "eval",
    message: "calling a constructor can build a Function",
  },
  {
    pattern: ident("require"),
    capability: "require",
    message: "require is not allowed; use import of a declared dependency",
  },
  {
    pattern: ident("fetch"),
    capability: "network",
    message: "the global fetch bypasses the egress list; use ctx.fetch",
  },
  {
    pattern: ident("XMLHttpRequest"),
    capability: "network",
    message: "XMLHttpRequest bypasses the egress list; use ctx.fetch",
  },
  {
    pattern: ident("WebSocket"),
    capability: "network",
    message: "WebSocket bypasses the egress list; use ctx.fetch",
  },
  {
    pattern: ident("EventSource"),
    capability: "network",
    message: "EventSource bypasses the egress list; use ctx.fetch",
  },
];

const IMPORT_SPEC = /\b(?:import|from)\s*["'`]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'`]?)/g;

function normalizeRelative(fromFile: string, specifier: string): string | undefined {
  const parts = fromFile.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/");
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function classifyImport(
  file: string,
  specifier: string,
  manifest: ModuleComponentManifest,
): { capability: string; message: string } | undefined {
  if (specifier.startsWith(".")) {
    return normalizeRelative(file, specifier) === undefined
      ? { capability: "import", message: `${specifier} leaves the component's directory` }
      : undefined;
  }
  if (/^https?:/i.test(specifier)) {
    return {
      capability: "network",
      message: `${specifier}: code fetched over the network is not allowed`,
    };
  }
  if (
    specifier.startsWith("/") ||
    (/^[a-z][a-z0-9+.-]*:/i.test(specifier) && !specifier.startsWith("node:"))
  ) {
    return {
      capability: "import",
      message: `${specifier}: only relative paths, declared dependencies and allowed node: modules can be imported`,
    };
  }
  const name = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  const isBuiltin =
    specifier.startsWith("node:") ||
    SAFE_BUILTINS.has(name) ||
    NETWORK_BUILTINS.has(name) ||
    EXEC_BUILTINS.has(name) ||
    FS_BUILTINS.has(name) ||
    OTHER_BUILTINS.has(name);
  if (isBuiltin) {
    if (SAFE_BUILTINS.has(name)) return undefined;
    if (NETWORK_BUILTINS.has(name)) {
      return {
        capability: "network",
        message: `${specifier} bypasses the egress list; use ctx.fetch`,
      };
    }
    if (EXEC_BUILTINS.has(name)) {
      return manifest.permissions?.exec === true
        ? undefined
        : { capability: "exec", message: `${specifier} needs permissions.exec: true` };
    }
    if (FS_BUILTINS.has(name)) {
      return (manifest.permissions?.fs ?? []).length > 0
        ? undefined
        : { capability: "fs", message: `${specifier} needs permissions.fs` };
    }
    return { capability: "import", message: `${specifier} is not an allowed built-in` };
  }
  return Object.hasOwn(manifest.deps ?? {}, packageName(specifier))
    ? undefined
    : { capability: "import", message: `${specifier} is not declared in deps` };
}

/**
 * Checks every JavaScript file of a module component against its manifest: no use of `process`, the
 * global object, `eval`, `require` or the global network APIs, and imports only of relative files,
 * declared dependencies and the built-ins the manifest's permissions allow. A best-effort static check:
 * it catches mistakes and obvious misbehaviour in reviewed code, and it can be evaded by code written to
 * evade it. See ADR-0031.
 */
export function scanModuleSources(
  manifest: ModuleComponentManifest,
  files: Record<string, string | Uint8Array>,
): ModuleViolation[] {
  const found: ModuleViolation[] = [];
  const decoder = new TextDecoder("utf-8");
  for (const file of Object.keys(files).sort()) {
    if (!SOURCE_FILE.test(file)) continue;
    const raw = files[file]!;
    const source = typeof raw === "string" ? raw : decoder.decode(raw);
    const { code, text } = blank(source);
    const add = (index: number, capability: string, message: string) =>
      found.push({ file, line: lineOf(source, index), capability, message });

    for (const rule of CODE_RULES) {
      for (const match of code.matchAll(rule.pattern))
        add(match.index!, rule.capability, rule.message);
    }

    const readSpecifier = (quoteAt: number): string | undefined => {
      const quote = text[quoteAt];
      if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
      const end = text.indexOf(quote, quoteAt + 1);
      return end === -1 ? undefined : text.slice(quoteAt + 1, end);
    };
    for (const match of code.matchAll(IMPORT_SPEC)) {
      const specifier = readSpecifier(match.index! + match[0].length - 1);
      if (specifier === undefined) continue;
      const problem = classifyImport(file, specifier, manifest);
      if (problem) add(match.index!, problem.capability, problem.message);
    }
    for (const match of code.matchAll(DYNAMIC_IMPORT)) {
      if (match[1] === "") {
        add(match.index!, "import", "a dynamic import must name its module with a string literal");
      }
      // A literal dynamic import is also matched by IMPORT_SPEC's `import (`? No: that needs a quote
      // straight after `import`, so classify it here.
      if (match[1] !== "") {
        const specifier = readSpecifier(match.index! + match[0].length - 1);
        if (specifier !== undefined) {
          const problem = classifyImport(file, specifier, manifest);
          if (problem) add(match.index!, problem.capability, problem.message);
        }
      }
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
