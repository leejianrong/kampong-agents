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
  /** The environment variable each secret slot reads. Absent in a record made before this was kept. */
  slotEnv?: Record<string, string>;
}

const sorted = <T extends string>(items: readonly T[] | undefined): T[] =>
  [...(items ?? [])].sort();

/** The grant a manifest makes, sorted and complete, so two spellings of one grant compare equal. */
export function permissionsOf(manifest: ComponentManifest): Permissions {
  const granted = manifest.permissions;
  const slots: Record<string, string[]> = {};
  const slotEnv: Record<string, string> = {};
  for (const name of Object.keys(manifest.auth?.slots ?? {}).sort()) {
    slots[name] = sorted(manifest.auth!.slots[name]!.hosts);
    slotEnv[name] = manifest.auth!.slots[name]!.env;
  }
  return {
    egress: sorted(granted?.egress),
    env: sorted(granted?.env),
    fs: sorted(granted?.fs),
    exec: granted?.exec === true,
    slots,
    slotEnv,
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
    const describeSlot = ([name, hosts]: [string, string[]]): string => {
      const env = permissions.slotEnv?.[name];
      return `${name} -> ${hosts.join(", ")}${env ? ` (reads ${env})` : ""}`;
    };
    parts.push(`secret slots: ${slots.map(describeSlot).join("; ")}`);
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
    const wasReading =
      before.slotEnv && Object.hasOwn(before.slotEnv, name) ? before.slotEnv[name] : undefined;
    const nowReading = after.slotEnv?.[name];
    if (
      known !== undefined &&
      wasReading !== undefined &&
      nowReading !== undefined &&
      wasReading !== nowReading
    ) {
      out.push(`secret slot ${name} now reads ${nowReading} instead of ${wasReading}`);
    }
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
  /** Comments and the contents of strings, regular expressions and template text replaced by spaces; code and newlines kept. */
  code: string;
  /** Comments replaced by spaces; strings kept, so an import specifier can be read. */
  text: string;
}

// After one of these a `/` starts a regular expression; after anything else that ends an operand it is
// a division.
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "instanceof",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);
const REGEX_AFTER_CHAR = "(,=:[!&|?{};+-*%<>~^";

/**
 * Blanks comments and the insides of strings, regular expressions and template text, so a forbidden word
 * in a comment or a message is not mistaken for code and a quote inside a regex does not confuse the
 * scan, while the code inside a template's `${}` is kept. Offsets and line breaks are preserved.
 */
function blank(source: string): Blanked {
  const code: string[] = [];
  const text: string[] = [];
  let i = 0;
  const n = source.length;
  const keepNewline = (ch: string): string => (ch === "\n" || ch === "\r" ? ch : " ");

  const lastSignificant = (): { char: string; word: string } => {
    let end = code.length - 1;
    while (end >= 0 && /\s/.test(code[end]!)) end--;
    if (end < 0) return { char: "", word: "" };
    const char = code[end]!;
    let start = end;
    while (start >= 0 && /[\w$]/.test(code[start]!)) start--;
    return { char, word: code.slice(start + 1, end + 1).join("") };
  };

  const startsRegex = (): boolean => {
    const { char, word } = lastSignificant();
    if (char === "") return true;
    if (/[\w$]/.test(char)) return REGEX_AFTER_WORD.has(word);
    return REGEX_AFTER_CHAR.includes(char);
  };

  // Returns the end index (exclusive) of a regex literal starting at `from`, or -1 if it is not one.
  const regexEnd = (from: number): number => {
    let j = from + 1;
    let inClass = false;
    while (j < n && source[j] !== "\n") {
      const ch = source[j]!;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) {
        j++;
        while (j < n && /[a-z]/i.test(source[j]!)) j++;
        return j;
      }
      j++;
    }
    return -1;
  };

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
      if (c === "/" && startsRegex()) {
        const end = regexEnd(i);
        if (end !== -1) {
          code.push("/");
          text.push("/");
          for (let j = i + 1; j < end - 1; j++) {
            code.push(" ");
            text.push(" ");
          }
          code.push("/");
          text.push("/");
          i = end;
          continue;
        }
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

/** Maps a character offset to a 1-based line, without rescanning the file for each match. */
function lineFinder(source: string): (index: number) => number {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

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

const LOCAL = "; even a local variable with this name is refused, so rename it";

interface CodeRule {
  pattern: RegExp;
  capability: string;
  message: string;
  /** A plain identifier: skip it when it is only an object key (`{ name: 1 }`). */
  identifier?: boolean;
}

const ident = (name: string, capability: string, message: string, lookahead = ""): CodeRule => ({
  pattern: new RegExp(`(?<![.\\w$])${name}\\b${lookahead}`, "g"),
  capability,
  message,
  identifier: true,
});

const CODE_RULES: CodeRule[] = [
  ident(
    "process",
    "process",
    `process is not available to a module; use ctx.env and ctx.secrets${LOCAL}`,
  ),
  ident("globalThis", "global", `globalThis gives a module the host's globals${LOCAL}`),
  ident("global", "global", `global gives a module the host's globals${LOCAL}`),
  ident("eval", "eval", "eval is not allowed"),
  { pattern: /\bnew\s+Function\b/g, capability: "eval", message: "new Function is not allowed" },
  ident("Function", "eval", "Function() is not allowed", "(?=\\s*\\()"),
  {
    pattern: /\.\s*constructor\s*\(/g,
    capability: "eval",
    message: "calling a constructor can build a Function",
  },
  ident("require", "require", "require is not allowed; import a declared dependency instead"),
  ident("fetch", "network", `the global fetch bypasses the egress list; use ctx.fetch${LOCAL}`),
  ident("XMLHttpRequest", "network", "XMLHttpRequest bypasses the egress list; use ctx.fetch"),
  ident("WebSocket", "network", "WebSocket bypasses the egress list; use ctx.fetch"),
  ident("EventSource", "network", "EventSource bypasses the egress list; use ctx.fetch"),
];

/** True when the match at `index` is only an object key: `{ name: ...` or `, name: ...`. */
function isObjectKey(code: string, index: number, length: number): boolean {
  if (!/^\s*:/.test(code.slice(index + length))) return false;
  let before = index - 1;
  while (before >= 0 && /\s/.test(code[before]!)) before--;
  return before >= 0 && (code[before] === "{" || code[before] === ",");
}

// File-system calls that change something. Checked in a file that imports fs when the manifest declares
// `fs: [read]` only.
const FS_WRITE_API =
  /(?<![\w$])(?:write|writeSync|writev|writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|truncate|truncateSync|ftruncate|chmod|chown|lchown|fchmod|symlink|symlinkSync|link|linkSync|utimes|open|openSync)\b/g;

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

interface ImportProblem {
  capability: string;
  message: string;
}

function classifyImport(
  file: string,
  specifier: string,
  manifest: ModuleComponentManifest,
): { problem?: ImportProblem; fs?: boolean } {
  if (specifier.startsWith(".")) {
    return normalizeRelative(file, specifier) === undefined
      ? {
          problem: {
            capability: "import",
            message: `${specifier} leaves the component's directory`,
          },
        }
      : {};
  }
  if (/^https?:/i.test(specifier)) {
    return {
      problem: {
        capability: "network",
        message: `${specifier}: code fetched over the network is not allowed`,
      },
    };
  }
  if (
    specifier.startsWith("/") ||
    (/^[a-z][a-z0-9+.-]*:/i.test(specifier) && !specifier.startsWith("node:"))
  ) {
    return {
      problem: {
        capability: "import",
        message: `${specifier}: only relative paths, declared dependencies and allowed node: modules can be imported`,
      },
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
    if (SAFE_BUILTINS.has(name)) return {};
    if (NETWORK_BUILTINS.has(name)) {
      return {
        problem: {
          capability: "network",
          message: `${specifier} bypasses the egress list; use ctx.fetch`,
        },
      };
    }
    if (EXEC_BUILTINS.has(name)) {
      return manifest.permissions?.exec === true
        ? {}
        : { problem: { capability: "exec", message: `${specifier} needs permissions.exec: true` } };
    }
    if (FS_BUILTINS.has(name)) {
      return (manifest.permissions?.fs ?? []).length > 0
        ? { fs: true }
        : { problem: { capability: "fs", message: `${specifier} needs permissions.fs` } };
    }
    return {
      problem: { capability: "import", message: `${specifier} is not an allowed built-in` },
    };
  }
  return Object.hasOwn(manifest.deps ?? {}, packageName(specifier))
    ? {}
    : { problem: { capability: "import", message: `${specifier} is not declared in deps` } };
}

/**
 * Checks every JavaScript file of a module component against its manifest: no use of `process`, the
 * global object, `eval`, `require` or the global network APIs, and imports only of relative files,
 * declared dependencies and the built-ins the manifest's permissions allow (`fs: [read]` does not allow
 * a file-system write). A best-effort static check: it catches mistakes and obvious misbehaviour in
 * reviewed code, and it can be evaded by code written to evade it. See ADR-0031.
 */
export function scanModuleSources(
  manifest: ModuleComponentManifest,
  files: Record<string, string | Uint8Array>,
): ModuleViolation[] {
  const found: ModuleViolation[] = [];
  const decoder = new TextDecoder("utf-8");
  const mayWrite = (manifest.permissions?.fs ?? []).includes("write");
  for (const file of Object.keys(files).sort()) {
    if (!SOURCE_FILE.test(file)) continue;
    const raw = files[file]!;
    const source = typeof raw === "string" ? raw : decoder.decode(raw);
    const { code, text } = blank(source);
    const lineOf = lineFinder(source);
    const add = (index: number, capability: string, message: string) =>
      found.push({ file, line: lineOf(index), capability, message });

    for (const rule of CODE_RULES) {
      for (const match of code.matchAll(rule.pattern)) {
        if (rule.identifier && isObjectKey(code, match.index!, match[0].length)) continue;
        add(match.index!, rule.capability, rule.message);
      }
    }

    const readLiteral = (quoteAt: number): { value: string; end: number } | undefined => {
      const quote = text[quoteAt];
      if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
      const end = text.indexOf(quote, quoteAt + 1);
      return end === -1 ? undefined : { value: text.slice(quoteAt + 1, end), end };
    };
    let importsFs = false;
    for (const match of code.matchAll(IMPORT_SPEC)) {
      const literal = readLiteral(match.index! + match[0].length - 1);
      if (literal === undefined) continue;
      const result = classifyImport(file, literal.value, manifest);
      if (result.fs) importsFs = true;
      if (result.problem) add(match.index!, result.problem.capability, result.problem.message);
    }
    for (const match of code.matchAll(DYNAMIC_IMPORT)) {
      const literal = match[1] === "" ? undefined : readLiteral(match.index! + match[0].length - 1);
      // Only `import("literal")` can be checked; anything computed, templated or concatenated could name
      // any module, including one outside the component.
      const closed = literal !== undefined && /^\s*[),]/.test(text.slice(literal.end + 1));
      if (literal === undefined || !closed || literal.value.includes("${")) {
        add(
          match.index!,
          "import",
          "a dynamic import must name its module with a plain string literal",
        );
        continue;
      }
      const result = classifyImport(file, literal.value, manifest);
      if (result.fs) importsFs = true;
      if (result.problem) add(match.index!, result.problem.capability, result.problem.message);
    }

    // `fs: [read]` is a statement about reads; a call that changes the file system needs `write`.
    if (importsFs && !mayWrite) {
      for (const match of code.matchAll(FS_WRITE_API)) {
        add(
          match.index!,
          "fs",
          `${match[0]} can change the file system, which needs permissions.fs: write`,
        );
      }
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
