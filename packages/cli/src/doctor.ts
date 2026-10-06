import { existsSync, readdirSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { dirname, join } from "node:path";
import { desugarLegacyTool, DirectoryComponentRegistry, isFirstPartyId } from "@kampong/engine";
import {
  describePermissions,
  diffPermissions,
  permissionsOf,
  type AgentSpec,
  type ComponentManifest,
} from "@kampong/spec";
import { componentsDirFor, lockPathFor, readLockfile, registryFor } from "./components.js";

// `kampong doctor` (KAN-1836): a read-only preflight of what would stop a run. It reports names of
// environment variables, never their values, and makes no network call unless `online` is set.

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  status: CheckStatus;
  area: "spec" | "component" | "env" | "fixtures" | "network";
  message: string;
}

/** Resolves to undefined when the host accepted a connection, else a short reason. */
export type ConnectFn = (host: string, port: number) => Promise<string | undefined>;

export interface DoctorOptions {
  env: NodeJS.ProcessEnv;
  online?: boolean;
  /** With `replay`, each tool must have a recorded fixture. */
  toolsMode?: "live" | "record" | "replay";
  fixturesDir?: string;
  connect?: ConnectFn;
}

const ENV_REF = /\$\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const CONNECT_TIMEOUT_MS = 5_000;

export const tcpConnect: ConnectFn = (host, port) =>
  new Promise((resolve) => {
    const socket = netConnect({ host, port, timeout: CONNECT_TIMEOUT_MS });
    socket.once("connect", () => {
      socket.destroy();
      resolve(undefined);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(`timed out after ${CONNECT_TIMEOUT_MS / 1000}s`);
    });
    socket.once("error", (err) => {
      socket.destroy();
      resolve(err.message);
    });
  });

function envNamesIn(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(ENV_REF)) if (match[1] !== undefined) into.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) envNamesIn(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) envNamesIn(item, into);
  }
}

const isSet = (env: NodeJS.ProcessEnv, name: string): boolean =>
  env[name] !== undefined && env[name] !== "";

/** `host`, `host:port` or a URL to a dialable host and port; wildcards and templated hosts have none. */
function dialTarget(entry: string, defaultPort = 443): { host: string; port: number } | undefined {
  if (entry.includes("*") || entry.includes("{")) return undefined;
  const match = /^([A-Za-z0-9.-]+)(?::(\d+))?$/.exec(entry.trim());
  if (!match) return undefined;
  return { host: match[1]!, port: match[2] ? Number(match[2]) : defaultPort };
}

function fixturePrefix(toolName: string): string {
  // Mirrors the file name the record/replay layer uses (engine tool-fixtures.ts); a test pins it.
  return `${toolName.replace(/[^A-Za-z0-9_-]/g, "_") || "tool"}.`;
}

export async function runDoctor(
  spec: AgentSpec,
  specPath: string,
  options: DoctorOptions,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (status: CheckStatus, area: DoctorCheck["area"], message: string) =>
    checks.push({ status, area, message });
  const { env } = options;
  const hosts = new Map<string, { host: string; port: number }>();
  const addHost = (target: { host: string; port: number } | undefined) => {
    if (target) hosts.set(`${target.host}:${target.port}`, target);
  };
  const envChecked = new Set<string>();
  const checkEnv = (name: string, what: string, level: CheckStatus = "fail") => {
    const key = `${name}|${what}`;
    if (envChecked.has(key)) return;
    envChecked.add(key);
    if (isSet(env, name)) add("pass", "env", `${name} is set (${what})`);
    else add(level, "env", `${name} is not set (${what})`);
  };

  // Model.
  const model = spec.agent.model;
  if (model) {
    const key = model.api_key ? PLACEHOLDER.exec(model.api_key) : null;
    if (key) checkEnv(key[1]!, `${model.provider} model key`);
    if (model.provider === "ollama") {
      const url = new URL(model.base_url ?? "http://localhost:11434");
      addHost({
        host: url.hostname,
        port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      });
    }
  }

  // Tools.
  const tools = spec.agent.tools ?? [];
  const registry = registryFor(specPath);
  let lock: ReturnType<typeof readLockfile> | undefined;
  let lockError: string | undefined;
  const lockFor = () => {
    if (lock === undefined && lockError === undefined) {
      try {
        lock = readLockfile(specPath);
      } catch (err) {
        lockError = (err as Error).message;
      }
    }
    return lock;
  };
  const used = new Set<string>();
  for (const declared of tools) {
    const legacy = desugarLegacyTool(declared);
    const tool = legacy ?? declared;
    if (tool.action === "http_request") {
      const names = new Set<string>();
      envNamesIn(tool, names);
      for (const name of [...names].sort()) checkEnv(name, `used by tool ${tool.name}`);
      if (/^https?:\/\//.test(tool.url) && !tool.url.includes("{")) {
        const url = new URL(tool.url.replace(/\$\{[^}]*\}/g, "x"));
        addHost({
          host: url.hostname,
          port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
        });
      }
      continue;
    }
    if (tool.action !== "component") continue;
    const [id, version] = [
      tool.use.slice(0, tool.use.lastIndexOf("@")),
      tool.use.slice(tool.use.lastIndexOf("@") + 1),
    ];
    let manifest: ComponentManifest;
    let digest: string;
    try {
      const resolved = await registry.resolve(id, version);
      manifest = resolved.manifest;
      digest = resolved.digest;
    } catch (err) {
      add("fail", "component", `${tool.use}: ${(err as Error).message}`);
      continue;
    }
    if (!manifest.ops[tool.op]) {
      add("fail", "component", `${tool.use} has no op "${tool.op}" (used by tool ${tool.name})`);
    }
    if (!used.has(tool.use)) {
      used.add(tool.use);
      const permissions = permissionsOf(manifest);
      if (legacy !== undefined || isFirstPartyId(id)) {
        add(
          "pass",
          "component",
          `${tool.use} resolves (first-party; may do: ${describePermissions(permissions)})`,
        );
      } else {
        const pinned = lockFor();
        const pin =
          pinned && Object.hasOwn(pinned.components, tool.use)
            ? pinned.components[tool.use]
            : undefined;
        if (lockError) {
          add("fail", "component", `${tool.use}: ${lockError}`);
        } else if (!pin) {
          add(
            "fail",
            "component",
            `${tool.use} is not pinned in ${lockPathFor(specPath)}; run \`kampong lock\``,
          );
        } else if (pin.digest !== digest) {
          const wider = pin.permissions ? diffPermissions(pin.permissions, permissions) : [];
          add(
            "fail",
            "component",
            `${tool.use} changed since it was pinned; review it and run \`kampong lock --update\`` +
              (wider.length > 0 ? ` (it now may do more: ${wider.join("; ")})` : ""),
          );
        } else {
          add(
            "pass",
            "component",
            `${tool.use} resolves and matches its pin (may do: ${describePermissions(permissions)})`,
          );
        }
        if (manifest.kind === "module") {
          add(
            "warn",
            "component",
            `${tool.use} is a module: it runs in the engine's process, not in a sandbox (ADR-0031)`,
          );
        }
      }
      for (const host of permissions.egress) addHost(dialTarget(host));
    }
    // The secret slots this call reads, after the spec's remaps.
    const op = manifest.ops[tool.op];
    const slots = manifest.auth?.slots ?? {};
    const names =
      manifest.kind === "rest"
        ? ((op as { slots?: string[] } | undefined)?.slots ??
          Object.keys(slots).filter((n) => slots[n]!.inject))
        : Object.keys(slots);
    for (const name of names) {
      const slot = slots[name];
      if (!slot) continue;
      const remap =
        tool.secrets && Object.hasOwn(tool.secrets, name)
          ? PLACEHOLDER.exec(tool.secrets[name]!)
          : null;
      checkEnv(
        remap ? remap[1]! : slot.env,
        `secret slot ${name} of ${tool.use}`,
        manifest.kind === "module" ? "warn" : "fail",
      );
    }
  }

  // Manifests in the project's folder that did not load.
  if (existsSync(componentsDirFor(specPath))) {
    for (const problem of await new DirectoryComponentRegistry(
      componentsDirFor(specPath),
    ).problems()) {
      add("warn", "component", `a component did not load: ${problem.message}`);
    }
  }

  // Fixtures for replay.
  if (options.toolsMode === "replay") {
    const dir = options.fixturesDir ?? join(dirname(specPath), ".kampong", "fixtures");
    const files = existsSync(dir) ? readdirSync(dir) : [];
    for (const declared of tools) {
      const tool = desugarLegacyTool(declared) ?? declared;
      // A legacy tool's fixtures are filed under its own name; a component's under `<id>.<op>`.
      const name = desugarLegacyTool(declared)
        ? declared.name
        : tool.action === "component"
          ? `${tool.use.slice(0, tool.use.lastIndexOf("@"))}.${tool.op}`
          : tool.name;
      const prefix = fixturePrefix(name);
      if (files.some((f) => f.startsWith(prefix) && f.endsWith(".json"))) {
        add("pass", "fixtures", `tool ${declared.name} has a recorded fixture`);
      } else {
        add(
          "fail",
          "fixtures",
          `tool ${declared.name} has no recorded fixture in ${dir}; record one with --tools record`,
        );
      }
    }
  }

  // Reachability, only when asked: a plain TCP connection, no request is sent.
  if (options.online) {
    const connect = options.connect ?? tcpConnect;
    for (const target of [...hosts.values()].sort((a, b) => a.host.localeCompare(b.host))) {
      const problem = await connect(target.host, target.port);
      if (problem === undefined)
        add("pass", "network", `${target.host}:${target.port} is reachable`);
      else add("fail", "network", `${target.host}:${target.port} is not reachable: ${problem}`);
    }
  }
  return checks;
}
