// Vendored from packages/engine/src/component.ts as part of a `kampong export`
// -- see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. The
// only change from the source file is the type import, which now comes from
// the local ./spec-types.js rather than "@kampong/spec" (this project has no
// dependency on that package -- ADR-0002). From here on this file is yours: it
// will not be touched again by a future export.
//
import type {
  ComponentManifest,
  ModuleComponentManifest,
  OpEffect,
  RestComponentManifest,
  RestOp,
  SchemaNode,
  Tool,
} from "./spec-types.js";
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
  /**
   * Reads one of the non-secret environment variables the manifest names in `permissions.env`; any other
   * name is refused. Undefined when the variable is declared but not set.
   */
  env: { get(name: string): string | undefined };
  /**
   * A `fetch` that refuses any host outside the component's egress list, and, once the module has read
   * a secret slot, any host outside the hosts those slots are bound to. It never follows redirects on
   * its own: a 3xx comes back to the module, which must re-request through this function.
   */
  fetch: typeof fetch;
  signal: AbortSignal;
}

/** Runs `kind: module` components. The first implementation runs in-process; a sandbox can replace it. */
export interface ModuleRunner {
  /**
   * How far the runner keeps a module away from the host. `none` runs it in this process, where the
   * permission checks are the only fence; `sandbox` is a runner that confines the module itself
   * (ADR-0031). A runner that does not say is treated as `none`.
   */
  readonly isolation?: ModuleIsolation;
  invoke(
    manifest: ModuleComponentManifest,
    op: string,
    input: Record<string, unknown>,
    ctx: ModuleContext,
  ): Promise<unknown>;
}

export type ModuleIsolation = "none" | "sandbox";

export interface InvokeOpOptions {
  /**
   * Refuse a module op unless the runner provides at least this much isolation. A hosted server that
   * runs components with a tenant's secrets sets `sandbox`, so a module cannot run until a sandboxed
   * runner exists. Has no effect on a rest component, which runs no code.
   */
  requireIsolation?: ModuleIsolation;
  /** Non-secret per-use values the manifest declares under `config` (a project ref, a region). */
  config?: Record<string, string>;
  /** Remaps a secret slot to a different environment variable (`SLOT -> "${NAME}"` or `"NAME"`). */
  secretEnv?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: ToolFetchImpl;
  pacer?: HttpToolCallOptions["pacer"];
  clock?: HttpToolCallOptions["clock"];
  runner?: ModuleRunner;
  /**
   * The name the mock/record fixture layer files this call under. Defaults to `id.op`; the legacy
   * Slack and Gmail kinds pass the tool's own name so fixtures recorded before still match.
   */
  toolName?: string;
  /** Aborts a module op; by default one that runs longer than MODULE_TIMEOUT_MS is cancelled. */
  signal?: AbortSignal;
}

const MODULE_TIMEOUT_MS = 60_000;
const DEFAULT_CONFIG_PATTERN = "[A-Za-z0-9._-]+";

const own = (record: object | undefined, key: string): boolean =>
  record !== undefined && Object.hasOwn(record, key);

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
  if (!own(manifest.ops, opName)) return false;
  const effect: OpEffect = manifest.ops[opName]!.effect;
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
    if (!own(declared, key)) {
      throw fail(`${label}: config.${key} is not declared by this component`, "input");
    }
  }
  const resolved: Record<string, string> = {};
  const problems: string[] = [];
  for (const [key, param] of Object.entries(declared)) {
    const value = own(supplied, key) ? supplied[key] : param.default;
    if (value === undefined) {
      problems.push(`config.${key} is required`);
      continue;
    }
    // Anchored: a config value forms part of a host, so a pattern like [a-z]+ must not let
    // "a.evil.com" through by matching only a prefix.
    const source = param.pattern ?? DEFAULT_CONFIG_PATTERN;
    if (!new RegExp(`^(?:${source})$`).test(value))
      problems.push(`config.${key} must match ${source}`);
    resolved[key] = value;
  }
  if (problems.length > 0) throw fail(`${label}: ${problems.join("; ")}`, "input");
  return resolved;
}

function withConfig(text: string, config: Record<string, string>): string {
  return text.replace(/\{\{\s*config\.([A-Za-z0-9_]+)\s*\}\}/g, (_m, key: string) =>
    own(config, key) ? config[key]! : "",
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

function slotOf(manifest: ComponentManifest, slot: string) {
  if (!own(manifest.auth?.slots, slot)) {
    throw fail(`secret slot "${slot}" is not declared by ${manifest.id}`, "permission");
  }
  return manifest.auth!.slots[slot]!;
}

function slotEnvName(
  manifest: ComponentManifest,
  slot: string,
  secretEnv?: Record<string, string>,
): string {
  const declared = slotOf(manifest, slot);
  if (own(secretEnv, slot)) {
    const remap = secretEnv![slot]!;
    return /^\$\{(.+)\}$/.exec(remap)?.[1] ?? remap;
  }
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

// The same grammar the manifest lint enforces: `{{ input.x }}` and `{{ config.x }}`.
const WHOLE_INPUT_REF = /^\{\{\s*input\.([A-Za-z0-9_]+)\s*\}\}$/;
const ANY_REF = /\{\{\s*(input|config)\.([A-Za-z0-9_]+)\s*\}\}/g;
const SECRET_REF = /\{\{\s*secret\s*\}\}/g;
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

function wholeInputRef(text: string): string | null {
  return WHOLE_INPUT_REF.exec(text)?.[1] ?? null;
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

// Input placed in a URL is percent-encoded so it cannot add path segments, a query or a fragment;
// config values (validated against an anchored pattern) are placed as written because they form the
// host. A missing or empty input, or a "." / ".." segment (which `new URL` would resolve away,
// walking out of the intended path), is an error rather than a silently different URL.
function renderUrlTemplate(
  template: string,
  input: Record<string, unknown>,
  config: Record<string, string>,
  label: string,
): string {
  return escapeEnvRefs(
    template.replace(ANY_REF, (_m, scope: string, key: string) => {
      if (scope === "config") return config[key] ?? "";
      const text = asText(input[key]);
      if (text === "")
        throw fail(`${label}: input.${key} is used in the url and must not be empty`, "input");
      if (text === "." || text === "..") {
        throw fail(
          `${label}: input.${key} must not be a relative path segment ("${text}")`,
          "input",
        );
      }
      return encodeURIComponent(text);
    }),
  );
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
  const url = withConfig(renderUrlTemplate(op.request.url, input, config, label), config);

  let parsed: URL;
  try {
    parsed = new URL(url);
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

  // Only the slots this op names (all injectable ones when it names none) are injected and checked.
  const slotNames =
    op.slots ??
    Object.entries(manifest.auth?.slots ?? {})
      .filter(([, slot]) => slot.inject)
      .map(([name]) => name);
  for (const slotName of slotNames) {
    const slot = slotOf(manifest, slotName);
    if (!slot.inject) continue;
    const slotHosts = slot.hosts.map((host) => withConfig(host, config));
    if (!hostAllowed(parsed, slotHosts)) {
      throw fail(
        `${label}: secret slot "${slotName}" may not be sent to ${parsed.host} (bound to ${slotHosts.join(", ")})`,
        "permission",
      );
    }
    const placeholder = `\${${slotEnvName(manifest, slotName, options.secretEnv)}}`;
    const value = slot.inject.template.replace(SECRET_REF, () => placeholder);
    if (slot.inject.header !== undefined) {
      // Header names are case-insensitive: the injected value replaces any other casing.
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === slot.inject.header.toLowerCase()) delete headers[existing];
      }
      headers[slot.inject.header] = value;
    } else {
      query[slot.inject.query!] = value;
    }
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
    name: options.toolName ?? `${manifest.id}.${opName}`,
    action: "http_request",
    method: op.request.method,
    url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(op.response ? { response: op.response } : {}),
    ...(op.failure_when ? { failure_when: op.failure_when } : {}),
    ...(op.pace ? { pace: op.pace } : {}),
    ...(op.retry ? { retry: op.retry } : {}),
  };
}

// ---- The pipeline ------------------------------------------------------------------------------------

export async function invokeOp(
  manifest: ComponentManifest,
  opName: string,
  input: unknown,
  options: InvokeOpOptions = {},
): Promise<unknown> {
  const label = `Tool "${manifest.id}.${opName}"`;
  // `own`, not `in` or indexing: an op name like "constructor" must not resolve to Object's.
  if (!own(manifest.ops, opName)) {
    throw fail(
      `${label}: ${manifest.id} has no op "${opName}" (it has ${Object.keys(manifest.ops).join(", ")})`,
      "input",
    );
  }
  const op = manifest.ops[opName]!;
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

function scrub(err: unknown, secrets: string[]): void {
  if (!(err instanceof Error)) return;
  err.message = redactString(err.message, secrets);
  if (err.stack) err.stack = redactString(err.stack, secrets);
  if (err.cause) scrub(err.cause, secrets);
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
  if (options.requireIsolation === "sandbox" && options.runner.isolation !== "sandbox") {
    throw fail(
      `${label}: ${manifest.id} is a module and the runner provides ${options.runner.isolation ?? "no"} isolation, but a sandbox is required`,
      "permission",
    );
  }
  const egress = egressOf(manifest, config);
  const declaredEnv = manifest.permissions?.env ?? [];
  const used: string[] = [];
  const readSlotHosts: string[] = [];
  const send = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const signal = options.signal ?? AbortSignal.timeout(MODULE_TIMEOUT_MS);
  // An already-aborted signal never fires its event, so check it before the module gets to run.
  if (signal.aborted) {
    throw new ToolCallError(`${label}: cancelled before the module ran`, "timeout", false);
  }

  const ctx: ModuleContext = {
    secrets: {
      get(slot) {
        const declared = slotOf(manifest, slot);
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
        readSlotHosts.push(...declared.hosts.map((host) => withConfig(host, config)));
        return value;
      },
    },
    env: {
      get(name) {
        if (!declaredEnv.includes(name)) {
          throw fail(
            `${label}: environment variable ${name} is not declared in permissions.env`,
            "permission",
          );
        }
        return env[name];
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
      // Best-effort until modules run in a sandbox: after reading a secret, the module may only talk to
      // the hosts that secret is bound to, so reading a token and posting it to another allowed host
      // is refused.
      if (readSlotHosts.length > 0 && !hostAllowed(url, readSlotHosts)) {
        throw fail(
          `${label}: host ${url.host} is not one this module's secrets are bound to (${readSlotHosts.join(", ")})`,
          "permission",
        );
      }
      // Redirects are never followed implicitly, so credentials cannot be carried to a new host.
      return send(
        url.toString(),
        { ...init, redirect: "manual" },
        {
          toolName: options.toolName ?? `${manifest.id}.${opName}`,
          secrets: used,
        },
      );
    },
    signal,
  };

  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () =>
        reject(new ToolCallError(`${label}: the module did not finish in time`, "timeout", false)),
      { once: true },
    );
  });

  try {
    return await Promise.race([options.runner.invoke(manifest, opName, input, ctx), aborted]);
  } catch (err) {
    scrub(err, used);
    if (err instanceof ToolCallError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ToolCallError(
      redactString(`${label} failed: ${message}`, used),
      "http",
      false,
      undefined,
      undefined,
      {
        cause: err,
      },
    );
  }
}
