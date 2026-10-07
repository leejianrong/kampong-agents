import { existsSync, readdirSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { dirname, join } from "node:path";
import {
  desugarLegacyTool,
  DirectoryComponentRegistry,
  fixtureFilePrefix,
  moduleFixtureFilePrefix,
  InProcessModuleRunner,
  invokeOp,
  isFirstPartyId,
  ToolCallError,
  type ComponentTool,
  type ToolFetchImpl,
} from "@kampong/engine";
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
  /**
   * Call each credential's probe op (a read-only request to the service, carrying the credential).
   * Off by default: it is the one check that sends a secret over the network.
   */
  probe?: boolean;
  /** Test seam for the probe's HTTP calls; the real `fetch` otherwise. */
  probeFetch?: ToolFetchImpl;
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

function urlTarget(raw: string): { host: string; port: number } | undefined {
  try {
    const url = new URL(raw);
    return { host: url.hostname, port: Number(url.port) || (url.protocol === "https:" ? 443 : 80) };
  } catch {
    return undefined;
  }
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
  if (!model) {
    add("fail", "spec", "agent.model is not configured; a run needs a provider, name and key");
  } else if (model.provider === "ollama") {
    // A local model needs no key (a stray api_key is ignored by a run, so it is not checked).
    const target = urlTarget(model.base_url ?? "http://localhost:11434");
    if (target) addHost(target);
    else add("fail", "spec", `agent.model.base_url is not a valid URL`);
  } else {
    const key = model.api_key ? PLACEHOLDER.exec(model.api_key) : null;
    if (key) checkEnv(key[1]!, `${model.provider} model key`);
    else
      add(
        "fail",
        "spec",
        `agent.model.api_key must be a \${ENV_VAR} placeholder for ${model.provider}`,
      );
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
  // A component is probed only when its bytes are the ones a reviewer pinned (or it ships with kampong).
  const trusted = new Map<string, string | true>();
  const moduleKinds = new Map<string, string>();
  const probes = new Map<
    string,
    { use: string; manifest: ComponentManifest; slot: string; envName: string; tool: ComponentTool }
  >();
  const unprobed = new Set<string>();
  for (const declared of tools) {
    const legacy = desugarLegacyTool(declared);
    const tool = legacy ?? declared;
    if (tool.action === "http_request") {
      // Only the request fields are resolved by the engine; a name or note is never read for ${VAR}.
      const names = new Set<string>();
      envNamesIn([tool.url, tool.headers, tool.query, tool.body], names);
      for (const name of [...names].sort()) checkEnv(name, `used by tool ${tool.name}`);
      // A host supplied by an environment variable is not known here, so it is not dialed.
      if (/^https?:\/\//.test(tool.url) && !tool.url.includes("${")) {
        const target = urlTarget(tool.url);
        if (target) addHost(target);
        else add("fail", "spec", `tool ${tool.name}: url is not a valid URL`);
      }
      continue;
    }
    if (tool.action !== "component") continue;
    const at = tool.use.lastIndexOf("@");
    if (at <= 0) {
      add("fail", "component", `${tool.use}: expected "id@version" (for example acme/echo@1.0.0)`);
      continue;
    }
    const [id, version] = [tool.use.slice(0, at), tool.use.slice(at + 1)];
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
    moduleKinds.set(tool.use, manifest.kind);
    if (!used.has(tool.use)) {
      used.add(tool.use);
      const permissions = permissionsOf(manifest);
      if (legacy !== undefined || isFirstPartyId(id)) {
        add(
          "pass",
          "component",
          `${tool.use} resolves (first-party; may do: ${describePermissions(permissions)})`,
        );
        trusted.set(tool.use, true);
      } else {
        const pinned = lockFor();
        const pin =
          pinned && Object.hasOwn(pinned.components, tool.use)
            ? pinned.components[tool.use]
            : undefined;
        if (lockError) {
          add("fail", "component", `${tool.use}: ${lockError}`);
          trusted.set(tool.use, "its lockfile is unreadable");
        } else if (!pin) {
          trusted.set(tool.use, "it is not pinned");
          add(
            "fail",
            "component",
            `${tool.use} is not pinned in ${lockPathFor(specPath)}; run \`kampong lock\``,
          );
        } else if (pin.digest !== digest) {
          trusted.set(tool.use, "it changed since it was pinned");
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
          trusted.set(tool.use, true);
        }
        if (manifest.kind === "module") {
          add(
            "warn",
            "component",
            `${tool.use} is a module: it runs in the engine's process, not in a sandbox (ADR-0031)`,
          );
        }
      }
    }
    for (const host of manifest.permissions?.egress ?? []) {
      const resolved = host.replace(/\{\{\s*config\.([A-Za-z0-9_]+)\s*\}\}/g, (m, key: string) =>
        tool.config && Object.hasOwn(tool.config, key) ? tool.config[key]! : m,
      );
      const target = dialTarget(resolved);
      if (target) addHost(target);
      else if (!host.includes("*")) unprobed.add(`${tool.use} egress ${resolved}`);
    }
    // The secret slots this call reads, after the spec's remaps.
    const op = manifest.ops[tool.op];
    const slots = manifest.auth?.slots ?? {};
    const names =
      manifest.kind === "rest"
        ? ((op as { slots?: string[] } | undefined)?.slots ?? Object.keys(slots)).filter(
            (n) => slots[n]?.inject,
          )
        : Object.keys(slots);
    for (const name of names) {
      const slot = slots[name];
      if (!slot) continue;
      // As the engine reads a remap: `${NAME}`, or a bare name.
      const remapped =
        tool.secrets && Object.hasOwn(tool.secrets, name) ? tool.secrets[name]! : undefined;
      const envName =
        remapped === undefined ? slot.env : (/^\$\{(.+)\}$/.exec(remapped)?.[1] ?? remapped);
      if (slot.probe)
        probes.set(`${tool.use}|${name}|${envName}|${JSON.stringify(tool.config ?? {})}`, {
          use: tool.use,
          manifest,
          slot: name,
          envName,
          tool,
        });
      checkEnv(
        envName,
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
      // A module op is filed under its own prefix (KAN-1833); the legacy kinds keep their HTTP fixtures.
      const moduleOp =
        tool.action === "component" &&
        !desugarLegacyTool(declared) &&
        moduleKinds.get(tool.use) === "module";
      const prefix = moduleOp ? moduleFixtureFilePrefix(name) : fixtureFilePrefix(name);
      if (files.some((f) => f.startsWith(prefix) && f.endsWith(".json"))) {
        add("pass", "fixtures", `tool ${declared.name} has a recorded fixture`);
      } else {
        // A module op is recorded at the invoke(op) boundary (KAN-1833), so every kind of tool needs one.
        add(
          "fail",
          "fixtures",
          `tool ${declared.name} has no recorded fixture in ${dir}; record one with --tools record`,
        );
      }
    }
  }

  // Credentials, only when asked: one read-only request per secret, to the host its slot is bound to.
  if (options.probe) {
    const runner = new InProcessModuleRunner(registry);
    const probeOne = async ({
      use,
      manifest,
      slot,
      envName,
      tool,
    }: {
      use: string;
      manifest: ComponentManifest;
      slot: string;
      envName: string;
      tool: ComponentTool;
    }): Promise<DoctorCheck | undefined> => {
      const what = `the credential in ${envName} (slot ${slot} of ${use})`;
      const check = (status: CheckStatus, message: string): DoctorCheck => ({
        status,
        area: "network",
        message: `${what} ${message}`,
      });
      const probe = manifest.auth!.slots[slot]!.probe!;
      if (!isSet(env, envName)) return undefined; // already reported as not set
      const reason = trusted.get(use);
      if (reason !== true) {
        return check("warn", `was not probed: ${reason ?? "the component was not checked"}`);
      }
      if (manifest.kind === "module" && !isFirstPartyId(manifest.id)) {
        return check("warn", "was not probed: doctor does not run a project module's code");
      }
      try {
        await invokeOp(manifest, probe.op, probe.with ?? {}, {
          config: tool.config,
          secretEnv: tool.secrets,
          env,
          runner,
          fetchImpl: options.probeFetch,
          toolName: `doctor.${manifest.id}.${probe.op}`,
        });
        return check("pass", `was accepted (${probe.op})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 401 is the service saying the credential is not valid. Anything else (a 403 that may be a
        // missing scope, a gateway, a quota, a 5xx, a timeout) says nothing about the credential unless
        // the component declares, in `probe.refused_when`, a reason that does (ADR-0032).
        const status =
          err instanceof ToolCallError
            ? (err.status ?? (err.cause as { status?: number } | undefined)?.status)
            : undefined;
        const refused =
          status === 401 || (probe.refused_when ?? []).some((reason) => message.includes(reason));
        return check(
          refused ? "fail" : "warn",
          `${refused ? "was refused" : "could not be confirmed"}: ${message}`,
        );
      }
    };
    // Independent requests: run together, report in the order the tools were declared.
    for (const result of await Promise.all([...probes.values()].map(probeOne))) {
      if (result) checks.push(result);
    }
  }

  // Reachability, only when asked: a plain TCP connection, no request is sent.
  if (options.online) {
    const connect = options.connect ?? tcpConnect;
    for (const what of [...unprobed].sort())
      add("warn", "network", `${what} depends on config that is not set here; not probed`);
    for (const target of [...hosts.values()].sort((a, b) => a.host.localeCompare(b.host))) {
      const problem = await connect(target.host, target.port);
      if (problem === undefined)
        add("pass", "network", `${target.host}:${target.port} is reachable`);
      else add("fail", "network", `${target.host}:${target.port} is not reachable: ${problem}`);
    }
  }
  return checks;
}
