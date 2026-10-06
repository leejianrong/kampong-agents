import type {
  ComponentManifest,
  ModuleComponentManifest,
  OpEffect,
  RestComponentManifest,
  RestOp,
  SchemaNode,
  Tool,
} from "@kampong/spec";
import {
  callHttpTool,
  ToolCallError,
  type HttpToolCallOptions,
  type ToolFetchImpl,
} from "./http-tool.js";
import { redactString } from "./redact.js";
import { applySchemaDefaults, validateAgainstSchema } from "./schema-validate.js";

// The connector op-call pipeline (KAN-1832 part A, ADR-0029). Given a manifest that has already been
// resolved and linted, it:
//
//   1. validates the call's input (and fills defaults) against the op's declared schema,
//   2. checks the component's config values,
//   3. renders the request from the manifest's templates,
//   4. enforces permissions: the target host must be in the manifest's egress list, and a secret may
//      only travel to a host its slot is bound to,
//   5. runs the request through the shared HTTP machinery (pacing, retry, failure rules), or hands a
//      module op to the Runner,
//   6. validates the result against the op's declared output.
//
// Nothing is sent before steps 1 to 4 pass. Resolving `id@version` to a manifest, and hooking this into
// the workflow, is the registry's job (part B).

type HttpTool = Extract<Tool, { action: "http_request" }>;

export interface ModuleContext {
  /** Reads a declared secret slot from the environment. Modules never see `process.env` directly. */
  secrets: { get(slot: string): string };
  /** A `fetch` that refuses any host outside the component's egress list. */
  fetch: typeof fetch;
  signal: AbortSignal;
}

/** Runs `kind: module` components. The first implementation runs in-process; a sandbox can replace it. */
export interface ModuleRunner {
  invoke(
    manifest: ModuleComponentManifest,
    op: string,
    input: Record<string, unknown>,
    ctx: ModuleContext,
  ): Promise<unknown>;
}

export interface InvokeOpOptions {
  /** Non-secret per-use values the manifest declares under `config` (a project ref, a region). */
  config?: Record<string, string>;
  /** Remaps a secret slot to a different environment variable (`SLOT -> "${NAME}"` or `"NAME"`). */
  secretEnv?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: ToolFetchImpl;
  pacer?: HttpToolCallOptions["pacer"];
  clock?: HttpToolCallOptions["clock"];
  runner?: ModuleRunner;
  signal?: AbortSignal;
}

const DEFAULT_CONFIG_PATTERN = /^[A-Za-z0-9._-]+$/;

function fail(message: string, code: ToolCallError["code"]): ToolCallError {
  return new ToolCallError(message, code, false);
}

/** The approval default for an op: a destructive op asks a human unless the spec says otherwise. */
export function opRequiresApproval(
  manifest: ComponentManifest,
  opName: string,
  explicit?: boolean,
): boolean {
  if (explicit !== undefined) return explicit;
  const effect: OpEffect | undefined = manifest.ops[opName]?.effect;
  return effect === "destructive";
}

// ---- Config, hosts, permissions ------------------------------------------------------------------

function resolveConfig(
  manifest: ComponentManifest,
  given: Record<string, string> | undefined,
  label: string,
): Record<string, string> {
  const declared = manifest.config ?? {};
  const supplied = given ?? {};
  for (const key of Object.keys(supplied)) {
    if (!(key in declared))
      throw fail(`${label}: config.${key} is not declared by this component`, "input");
  }
  const resolved: Record<string, string> = {};
  const problems: string[] = [];
  for (const [key, param] of Object.entries(declared)) {
    const value = supplied[key] ?? param.default;
    if (value === undefined) {
      problems.push(`config.${key} is required`);
      continue;
    }
    const pattern =
      param.pattern !== undefined ? new RegExp(param.pattern) : DEFAULT_CONFIG_PATTERN;
    if (!pattern.test(value))
      problems.push(`config.${key} must match ${param.pattern ?? DEFAULT_CONFIG_PATTERN.source}`);
    resolved[key] = value;
  }
  if (problems.length > 0) throw fail(`${label}: ${problems.join("; ")}`, "input");
  return resolved;
}

function withConfig(text: string, config: Record<string, string>): string {
  return text.replace(
    /\{\{\s*config\.([A-Za-z0-9_]+)\s*\}\}/g,
    (_m, key: string) => config[key] ?? "",
  );
}

function hostMatches(url: URL, pattern: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) {
    const rest = p.slice(2);
    return rest.includes(":")
      ? url.host.endsWith(`.${rest}`)
      : url.port === "" && url.hostname.endsWith(`.${rest}`);
  }
  return p.includes(":") ? url.host === p : url.port === "" && url.hostname === p;
}

function hostAllowed(url: URL, patterns: string[]): boolean {
  return patterns.some((pattern) => hostMatches(url, pattern));
}

function egressOf(manifest: ComponentManifest, config: Record<string, string>): string[] {
  return (manifest.permissions?.egress ?? []).map((entry) => withConfig(entry, config));
}

function slotEnvName(
  manifest: ComponentManifest,
  slot: string,
  secretEnv?: Record<string, string>,
): string {
  const remap = secretEnv?.[slot];
  if (remap !== undefined) return /^\$\{(.+)\}$/.exec(remap)?.[1] ?? remap;
  const declared = manifest.auth?.slots[slot];
  if (!declared)
    throw fail(`secret slot "${slot}" is not declared by ${manifest.id}`, "permission");
  return declared.env;
}

// ---- Input -----------------------------------------------------------------------------------------

function prepareInput(
  op: { input?: SchemaNode },
  input: unknown,
  label: string,
): Record<string, unknown> {
  if (
    input !== undefined &&
    (input === null || typeof input !== "object" || Array.isArray(input))
  ) {
    throw fail(`${label}: input must be an object`, "input");
  }
  const given = (input ?? {}) as Record<string, unknown>;
  const schema = op.input ?? { type: "object" as const };
  const filled = applySchemaDefaults(schema, given);
  const errors = validateAgainstSchema(schema, filled, "input");
  if (errors.length > 0) throw fail(`${label}: ${errors.join("; ")}`, "input");
  return filled;
}

// ---- Rendering a rest op's request -------------------------------------------------------------------

// A manifest never contains `${...}` (it is linted out), so any `${NAME}` in rendered text came from
// input data. Escaping it as `$${NAME}` makes the shared builder emit it literally, so input can never
// pull a secret out of the environment.
function escapeEnvRefs(text: string): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => `$$` + `{${name}}`);
}

const WHOLE_INPUT_REF = /^\{\{\s*input\.([A-Za-z0-9_]+)\s*\}\}$/;
const ANY_REF = /\{\{\s*(input|config)\.([A-Za-z0-9_]+)\s*\}\}/g;
const OMIT = Symbol("omit");

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string"
    ? value
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}

function renderText(
  template: string,
  input: Record<string, unknown>,
  config: Record<string, string>,
): string {
  return escapeEnvRefs(
    template.replace(ANY_REF, (_m, scope: string, key: string) =>
      scope === "input" ? asText(input[key]) : (config[key] ?? ""),
    ),
  );
}

function escapeDeep(value: unknown): unknown {
  if (typeof value === "string") return escapeEnvRefs(value);
  if (Array.isArray(value)) return value.map(escapeDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, escapeDeep(v)]),
    );
  }
  return value;
}

function renderJson(
  value: unknown,
  input: Record<string, unknown>,
  config: Record<string, string>,
): unknown {
  if (typeof value === "string") {
    const whole = wholeInputRef(value);
    if (whole !== null) return input[whole] === undefined ? OMIT : escapeDeep(input[whole]);
    return renderText(value, input, config);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderJson(entry, input, config)).filter((entry) => entry !== OMIT);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const rendered = renderJson(entry, input, config);
      if (rendered !== OMIT) out[key] = rendered;
    }
    return out;
  }
  return value;
}

function wholeInputRef(text: string): string | null {
  return WHOLE_INPUT_REF.exec(text)?.[1] ?? null;
}

function renderStringMap(
  map: Record<string, string> | undefined,
  input: Record<string, unknown>,
  config: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(map ?? {})) {
    const whole = wholeInputRef(template);
    if (whole !== null && input[whole] === undefined) continue; // an optional input that was not given
    out[name] = renderText(template, input, config);
  }
  return out;
}

function buildHttpTool(
  manifest: RestComponentManifest,
  opName: string,
  op: RestOp,
  input: Record<string, unknown>,
  config: Record<string, string>,
  options: InvokeOpOptions,
): HttpTool {
  const label = `Tool "${manifest.id}.${opName}"`;
  const urlWithConfig = renderUrlTemplate(op.request.url, input, config);

  let parsed: URL;
  try {
    parsed = new URL(urlWithConfig);
  } catch {
    throw fail(`${label}: the request url is not a valid URL after rendering`, "input");
  }
  // Permissions, checked before anything is sent.
  const egress = egressOf(manifest, config);
  if (!hostAllowed(parsed, egress)) {
    throw fail(
      `${label}: host ${parsed.host} is not in this component's egress list (${egress.join(", ") || "none"})`,
      "permission",
    );
  }

  const headers = renderStringMap(op.request.headers, input, config);
  const query = renderStringMap(op.request.query, input, config);
  for (const [slotName, slot] of Object.entries(manifest.auth?.slots ?? {})) {
    if (!slot.inject) continue;
    const slotHosts = slot.hosts.map((host) => withConfig(host, config));
    if (!hostAllowed(parsed, slotHosts)) {
      throw fail(
        `${label}: secret slot "${slotName}" may not be sent to ${parsed.host} (bound to ${slotHosts.join(", ")})`,
        "permission",
      );
    }
    const placeholder = `\${${slotEnvName(manifest, slotName, options.secretEnv)}}`;
    const value = slot.inject.template.split("{{ secret }}").join(placeholder);
    if (slot.inject.header !== undefined) headers[slot.inject.header] = value;
    else query[slot.inject.query!] = value;
  }

  let body: HttpTool["body"];
  if (op.request.body !== undefined) {
    if ("json" in op.request.body) {
      body = { json: renderJson(op.request.body.json, input, config) as Record<string, unknown> };
    } else if ("form" in op.request.body) {
      body = { form: renderStringMap(op.request.body.form, input, config) };
    } else {
      body = {
        raw: renderText(op.request.body.raw, input, config),
        ...(op.request.body.content_type ? { content_type: op.request.body.content_type } : {}),
      };
    }
  }

  return {
    name: `${manifest.id}.${opName}`,
    action: "http_request",
    method: op.request.method,
    url: urlWithConfig,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(op.response ? { response: op.response } : {}),
    ...(op.failure_when ? { failure_when: op.failure_when } : {}),
    ...(op.pace ? { pace: op.pace } : {}),
    ...(op.retry ? { retry: op.retry } : {}),
  };
}

// Input placed in a URL is percent-encoded so it cannot add path segments, a query or a fragment;
// config values (validated against a pattern) are placed as written because they form the host.
function renderUrlTemplate(
  template: string,
  input: Record<string, unknown>,
  config: Record<string, string>,
): string {
  return escapeEnvRefs(
    template.replace(ANY_REF, (_m, scope: string, key: string) =>
      scope === "input" ? encodeURIComponent(asText(input[key])) : (config[key] ?? ""),
    ),
  );
}

// ---- The pipeline ------------------------------------------------------------------------------------

export async function invokeOp(
  manifest: ComponentManifest,
  opName: string,
  input: unknown,
  options: InvokeOpOptions = {},
): Promise<unknown> {
  const label = `Tool "${manifest.id}.${opName}"`;
  const op = manifest.ops[opName];
  if (!op) {
    throw fail(
      `${label}: ${manifest.id} has no op "${opName}" (it has ${Object.keys(manifest.ops).join(", ")})`,
      "input",
    );
  }
  const prepared = prepareInput(op, input, label);
  const config = resolveConfig(manifest, options.config, label);
  const env = options.env ?? process.env;

  let result: unknown;
  if (manifest.kind === "rest") {
    const tool = buildHttpTool(manifest, opName, op as RestOp, prepared, config, options);
    result = await callHttpTool(
      tool,
      {},
      {
        fetchImpl: options.fetchImpl,
        env,
        pacer: options.pacer,
        clock: options.clock,
      },
    );
  } else {
    result = await runModule(manifest, opName, prepared, config, options, env, label);
  }

  const outputSchema = op.output;
  const isJson = manifest.kind !== "rest" || ((op as RestOp).response?.mode ?? "json") === "json";
  if (outputSchema && isJson) {
    const errors = validateAgainstSchema(outputSchema, result, "output");
    if (errors.length > 0) {
      throw fail(
        `${label}: the response did not match the declared output: ${errors.slice(0, 5).join("; ")}`,
        "http",
      );
    }
  }
  return result;
}

async function runModule(
  manifest: ModuleComponentManifest,
  opName: string,
  input: Record<string, unknown>,
  config: Record<string, string>,
  options: InvokeOpOptions,
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<unknown> {
  if (!options.runner) {
    throw fail(
      `${label}: ${manifest.id} is a module component and no module runner was provided`,
      "input",
    );
  }
  const egress = egressOf(manifest, config);
  const used: string[] = [];
  const send = options.fetchImpl ?? ((url, init) => fetch(url, init));

  const ctx: ModuleContext = {
    secrets: {
      get(slot) {
        const name = slotEnvName(manifest, slot, options.secretEnv);
        const value = env[name];
        if (value === undefined || value === "") {
          throw new ToolCallError(
            `${label}: environment variable ${name} is not set (secret slot "${slot}")`,
            "auth",
            false,
          );
        }
        used.push(value);
        return value;
      },
    },
    fetch: async (target, init) => {
      const url = new URL(String(target instanceof Request ? target.url : target));
      if (!hostAllowed(url, egress)) {
        throw fail(
          `${label}: host ${url.host} is not in this component's egress list (${egress.join(", ") || "none"})`,
          "permission",
        );
      }
      return send(url.toString(), init, { toolName: `${manifest.id}.${opName}`, secrets: used });
    },
    signal: options.signal ?? new AbortController().signal,
  };

  try {
    return await options.runner.invoke(manifest, opName, input, ctx);
  } catch (err) {
    if (err instanceof ToolCallError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ToolCallError(
      redactString(`${label} failed: ${message}`, used),
      "http",
      false,
      undefined,
      undefined,
      {
        cause:
          err instanceof Error
            ? Object.assign(err, { message: redactString(err.message, used) })
            : err,
      },
    );
  }
}
