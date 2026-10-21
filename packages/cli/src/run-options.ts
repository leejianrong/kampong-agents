import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  createFixtureFetch,
  createModelFixtures,
  createModuleFixtures,
  desugarLegacyTool,
  fixtureFilePrefix,
  instantClock,
  moduleFixtureFilePrefix,
  Pacer,
  type ModelClient,
  type ToolFetchImpl,
} from "@kampong/engine";
import type { AgentSpec, ComponentCatalog } from "@kampong/spec";
import { componentCatalogFor, registryFor } from "./components.js";
import { hasModelStep } from "./doctor.js";

// What a test run can do and how (KAM-188): replay the recorded fixtures (no keys, no network) or call the
// real services. The canvas asks `GET /api/run-options` which modes are open for the spec on disk and, for a
// live run, which tools would be called and which of them change something outside the project.

export type RunToolsMode = "live" | "replay";

const ENV_VAR_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Every resolved BYOK secret currently in play, so the mock/record layer never writes one to a fixture (AGENTS.md's secrets convention). */
function collectSecrets(spec: AgentSpec, env: NodeJS.ProcessEnv): string[] {
  const secrets: string[] = [];
  const apiKey = spec.agent.model?.api_key;
  const match = apiKey ? ENV_VAR_PATTERN.exec(apiKey) : null;
  if (match) {
    const value = env[match[1]!];
    if (value) secrets.push(value);
  }
  return secrets;
}

/**
 * `collectSecrets` plus the value of every secret slot a component tool reads (a slot remapped with
 * `secrets:`, else the component's own default variable). A tool result can carry such a value into a model
 * prompt, so the model fixture layer redacts it from a recording exactly as the tool layer does; without this a
 * replay (where the tool fixture says `[REDACTED]`) would ask for a prompt that was recorded with the live value.
 */
export async function collectRunSecrets(
  spec: AgentSpec,
  specPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const secrets = collectSecrets(spec, env);
  const registry = registryFor(specPath);
  for (const declared of spec.agent.tools ?? []) {
    const tool = desugarLegacyTool(declared) ?? declared;
    if (tool.action !== "component") continue;
    const at = tool.use.lastIndexOf("@");
    try {
      const { manifest } = await registry.resolve(tool.use.slice(0, at), tool.use.slice(at + 1));
      for (const [slot, def] of Object.entries(manifest.auth?.slots ?? {})) {
        const mapped = tool.secrets?.[slot];
        const name = mapped ? (ENV_VAR_PATTERN.exec(mapped)?.[1] ?? mapped) : def.env;
        const value = env[name];
        if (value) secrets.push(value);
      }
    } catch {
      // A component that cannot be resolved fails the run on its own, with a better message than this.
    }
  }
  return secrets;
}

/** Where `kampong run --tools replay` looks by default. */
export function defaultFixturesDir(specPath: string): string {
  return join(dirname(specPath), ".kampong", "fixtures");
}

function jsonFilesIn(dir: string): string[] {
  try {
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  } catch {
    return [];
  }
}

/**
 * The fixtures a canvas replay reads: `.kampong/fixtures` (where `kampong run` looks and a recording lands),
 * else a `fixtures/` folder beside the spec (how a template ships them). The first with a recording wins.
 */
export function replayFixturesDirFor(specPath: string): string | undefined {
  for (const dir of [defaultFixturesDir(specPath), join(dirname(specPath), "fixtures")]) {
    if (jsonFilesIn(dir).length > 0) return dir;
  }
  return undefined;
}

/** What a replay run needs in place of the real network and model. */
export interface ReplayDeps {
  fetchImpl: ToolFetchImpl;
  moduleFixtures: ReturnType<typeof createModuleFixtures>;
  model: ModelClient;
  toolClock: typeof instantClock;
  toolPacer: Pacer;
}

export async function replayDepsFor(
  spec: AgentSpec,
  specPath: string,
  fixturesDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReplayDeps> {
  const secrets = await collectRunSecrets(spec, specPath, env);
  return {
    fetchImpl: createFixtureFetch({ mode: "replay", fixturesDir, secrets }),
    moduleFixtures: createModuleFixtures({ mode: "replay", fixturesDir, secrets }),
    model: createModelFixtures({ mode: "replay", fixturesDir, secrets }),
    // Replaying recorded fixtures must not sit through real retry backoff or pacing delays.
    toolClock: instantClock,
    toolPacer: new Pacer(instantClock),
  };
}

export interface RunOptionsTool {
  name: string;
  /** What the call is, in a line: `POST https://...` or `kampong/slack post_message`. */
  describes: string;
  /** `write` and `destructive` change something outside the project; `unknown` is a component the catalog could not read. */
  effect: "read" | "write" | "destructive" | "unknown";
  /** True when a live run could change something outside the project (anything but `read`). */
  sideEffecting: boolean;
  requiresApproval: boolean;
  /** Whether a recorded fixture exists for it (always false when there are no fixtures). */
  recorded: boolean;
}

/** One of the spec's `vars`, as a test run lets you set it for a single run (KAM-191). */
export interface RunOptionsVar {
  name: string;
  type: "string" | "number" | "list";
  /** What a list holds; absent for the other types. */
  items?: "string" | "number";
  description?: string;
  /** The default as the text a field shows (a list comma-separated, `${ENV}` as written); absent when the var has none. */
  default?: string;
}

export interface RunOptions {
  /** The modes this server can run, in the order the canvas offers them. */
  modes: RunToolsMode[];
  /** The mode the canvas should start on: replay when fixtures exist, else live. */
  defaultMode: RunToolsMode;
  fixtures: {
    available: boolean;
    /** Relative to the working directory, never absolute. */
    dir?: string;
    count: number;
  };
  tools: RunOptionsTool[];
  /** The spec's declared `vars`, in declaration order; empty for a spec without any (and for every 1.0 spec). */
  vars: RunOptionsVar[];
  /** True when the workflow has a model step, which a live run sends to the model provider. */
  modelCalls: boolean;
}

function catalogEffect(
  catalog: ComponentCatalog,
  use: string,
  op: string,
): RunOptionsTool["effect"] {
  const at = use.lastIndexOf("@");
  const entry = catalog.components.find(
    (c) => c.id === use.slice(0, at) && c.version === use.slice(at + 1),
  );
  return entry && Object.hasOwn(entry.ops, op) ? entry.ops[op]!.effect : "unknown";
}

export async function describeRunOptions(spec: AgentSpec, specPath: string): Promise<RunOptions> {
  const dir = replayFixturesDirFor(specPath);
  const files = dir ? jsonFilesIn(dir) : [];
  const catalog = await componentCatalogFor(specPath);
  const tools: RunOptionsTool[] = (spec.agent.tools ?? []).map((declared) => {
    const tool = desugarLegacyTool(declared) ?? declared;
    let effect: RunOptionsTool["effect"];
    let describes: string;
    let prefixes: string[];
    if (tool.action === "component") {
      const id = tool.use.slice(0, tool.use.lastIndexOf("@"));
      effect = catalogEffect(catalog, tool.use, tool.op);
      describes = `${id} ${tool.op}`;
      prefixes = [
        fixtureFilePrefix(`${id}.${tool.op}`),
        moduleFixtureFilePrefix(`${id}.${tool.op}`),
      ];
      if (desugarLegacyTool(declared)) prefixes.push(fixtureFilePrefix(declared.name));
    } else if (tool.action === "http_request") {
      effect = ["GET", "HEAD"].includes(tool.method.toUpperCase()) ? "read" : "write";
      describes = `${tool.method.toUpperCase()} ${tool.url}`;
      prefixes = [fixtureFilePrefix(tool.name)];
    } else {
      // A connector with no component form; the engine desugars every one today, so this is unreachable.
      effect = "unknown";
      describes = tool.action;
      prefixes = [fixtureFilePrefix(tool.name)];
    }
    return {
      name: declared.name,
      describes,
      effect,
      sideEffecting: effect !== "read",
      requiresApproval: declared.requires_approval === true,
      recorded: files.some((f) => prefixes.some((p) => f.startsWith(p))),
    };
  });
  const available = dir !== undefined;
  return {
    modes: available ? ["replay", "live"] : ["live"],
    defaultMode: available ? "replay" : "live",
    fixtures: {
      available,
      ...(dir && { dir: relative(process.cwd(), dir) || "." }),
      count: files.length,
    },
    tools,
    vars: Object.entries(spec.vars ?? {}).map(([name, def]) => ({
      name,
      type: def.type,
      ...(def.items && { items: def.items }),
      ...(def.description !== undefined && { description: def.description }),
      ...(def.default !== undefined && {
        default: Array.isArray(def.default) ? def.default.join(", ") : String(def.default),
      }),
    })),
    modelCalls: hasModelStep(spec.agent.workflow),
  };
}
