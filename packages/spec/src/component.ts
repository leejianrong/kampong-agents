import { z } from "zod";
import { LineCounter, parseDocument } from "yaml";
import { toSpecError, type SpecError } from "./parse.js";
import {
  failureRuleSchema,
  paceSchema,
  requestBodySchema,
  requestHeadersSchema,
  requestQuerySchema,
  requestResponseSchema,
  retrySchema,
} from "./request.js";
import { httpMethodSchema } from "./schema.js";
import { schemaNodeSchema, type SchemaNode } from "./schema-node.js";

export { schemaNodeSchema, type SchemaNode };

// The connector manifest (KAN-1832 part A, ADR-0025 and ADR-0029): one file that describes a
// component's operations so the engine can run them, the canvas can build forms for them and the
// exporter can vendor them, without any per-connector code in those places.
//
// A manifest is shareable, so it never holds a secret: credentials come in through named `auth`
// slots bound to the hosts they may be sent to, and a literal `${ENV}` inside a request is rejected.

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export const componentIdSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:[-.][a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'must be "namespace/name": lowercase letters, digits and hyphens (a reverse-DNS namespace such as com.acme is allowed)',
  );

// Exact versions only (ADR-0029): no ranges, tags or partial versions.
export const exactVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "must be an exact version such as 1.2.3");

export const effectSchema = z.enum(["read", "write", "destructive"]);

// ---- Permissions and auth --------------------------------------------------------------------------

// A host, optionally `host:port`, optionally a single leading `*.` wildcard, optionally referring to
// a config value (`{{ config.project }}.supabase.co`). Never a URL and never a bare wildcard.
const egressEntrySchema = z
  .string()
  .regex(/^[A-Za-z0-9.*{}_ :-]+$/, "must be a host or host:port, not a URL")
  .refine((entry) => !entry.includes("*") || /^\*\.[^*]*\.[^*]*$/.test(entry), {
    message:
      'a wildcard is only allowed as a leading "*." with at least two labels after it (*.example.com, never *.com)',
  });

// What a component may do beyond its declared secrets (ADR-0026, ADR-0031). `egress` is enforced by the
// op-call pipeline on every request. `env`, `fs` and `exec` apply to a module's code: a module gets only
// the named env variables through `ctx.env`, and a static check refuses code that reaches for the file
// system or a child process without declaring it. A rest component runs no code, so it declares none.
// Plain env is for configuration (a timezone, a log level). A name that reads as a credential is
// refused so it cannot be read through `ctx.env` without the host binding an auth slot gives it.
const SECRET_LOOKING = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|PRIVATE/i;

const unique = (items: readonly unknown[]): boolean => new Set(items).size === items.length;

const permissionsSchema = z
  .object({
    egress: z.array(egressEntrySchema).refine(unique, "duplicate entry").optional(),
    env: z
      .array(z.string().regex(NAME, "must be an environment variable name such as TZ"))
      .refine(unique, "duplicate entry")
      .optional(),
    fs: z
      .array(z.enum(["read", "write"]))
      .refine(unique, "duplicate entry")
      .optional(),
    exec: z.boolean().optional(),
  })
  .strict();

const slotSchema = z
  .object({
    /** The environment variable read by default; a spec can remap it. */
    env: z.string().regex(NAME, "must be an environment variable name such as SLACK_BOT_TOKEN"),
    /** The only hosts this secret may be sent to. */
    hosts: z.array(egressEntrySchema).min(1),
    /**
     * A read-only op that proves the credential is accepted (Slack `auth.test`, Gmail `getProfile`).
     * `kampong doctor --probe` calls it with `with` as input; nothing else ever does (ADR-0032).
     */
    probe: z
      .object({
        op: z.string().regex(NAME, "op names are letters, digits and underscores"),
        with: z.record(z.string(), z.unknown()).optional(),
        /**
         * Reasons (text found in the failure message, such as Slack's `invalid_auth`) that mean the
         * credential is not valid. A 401 always does; any other failure only warns unless it matches.
         */
        refused_when: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    /** How the engine attaches it to a request. Slots used only by modules omit this. */
    inject: z
      .object({
        header: z.string().regex(HEADER_NAME).optional(),
        query: z.string().min(1).optional(),
        template: z.string(),
      })
      .strict()
      .superRefine((inject, ctx) => {
        if ((inject.header === undefined) === (inject.query === undefined)) {
          ctx.addIssue({ code: "custom", message: "inject needs exactly one of header or query" });
        }
        if (!/\{\{\s*secret\s*\}\}/.test(inject.template)) {
          ctx.addIssue({
            code: "custom",
            message: 'inject template must contain "{{ secret }}"',
            path: ["template"],
          });
        }
      })
      .optional(),
  })
  .strict();

const authSchema = z.object({ slots: z.record(z.string().regex(NAME), slotSchema) }).strict();

const validRegex = (pattern: string): boolean => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

const configParamSchema = z
  .object({
    type: z.literal("string"),
    title: z.string().optional(),
    description: z.string().optional(),
    default: z.string().optional(),
    /**
     * Config values can end up in a host name, so the engine anchors this pattern (it must match the
     * whole value) and, when none is given, applies a restrictive default.
     */
    pattern: z.string().refine(validRegex, "not a valid regular expression").optional(),
  })
  .strict()
  .superRefine((param, ctx) => {
    if (param.default !== undefined && param.pattern !== undefined && validRegex(param.pattern)) {
      if (!new RegExp(`^(?:${param.pattern})$`).test(param.default)) {
        ctx.addIssue({
          code: "custom",
          message: "default does not match its own pattern",
          path: ["default"],
        });
      }
    }
  });

// ---- Operations ------------------------------------------------------------------------------------

const inputSchema = schemaNodeSchema.refine((node) => node.type === "object", {
  message: "an op input must be an object schema (type: object)",
});

const restRequestSchema = z
  .object({
    method: httpMethodSchema,
    url: z.string().min(1),
    headers: requestHeadersSchema.optional(),
    query: requestQuerySchema.optional(),
    body: requestBodySchema.optional(),
  })
  .strict();

const restOpSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    effect: effectSchema,
    input: inputSchema.optional(),
    request: restRequestSchema,
    /** Which auth slots this op injects. Omitted means every slot that has an inject rule. */
    slots: z.array(z.string()).optional(),
    response: requestResponseSchema.optional(),
    failure_when: z.array(failureRuleSchema).optional(),
    output: schemaNodeSchema.optional(),
    pace: paceSchema.optional(),
    retry: retrySchema.optional(),
    /** Input properties that identify a call when recording and replaying (default: all of them). */
    fixture_key: z.array(z.string()).optional(),
  })
  .strict();

const moduleOpSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    effect: effectSchema,
    input: inputSchema.optional(),
    output: schemaNodeSchema.optional(),
    /**
     * Re-attempts after a failure the module reports as retryable: an error carrying an HTTP-style `status`
     * of 429, 408 or 5xx (a read op only, except 429), or `retryable: true` and an optional `retryAfterMs`.
     */
    retry: retrySchema.optional(),
    fixture_key: z.array(z.string()).optional(),
  })
  .strict();

const hasAnOp = (ops: Record<string, unknown>): boolean => Object.keys(ops).length > 0;

const opName = z.string().regex(NAME, "op names are letters, digits and underscores");

const header = {
  id: componentIdSchema,
  version: exactVersionSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  license: z.string().optional(),
  permissions: permissionsSchema.optional(),
  auth: authSchema.optional(),
  config: z.record(z.string().regex(NAME), configParamSchema).optional(),
};

// Exact pins only: a range, tag, URL or path in `deps` would let the code change under a digest.
const exactDependencySchema = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    "must be an exact version such as 1.2.3 (no range, tag, URL or path)",
  );

// An npm package name: no path segments, URL or alias syntax.
const dependencyNameSchema = z
  .string()
  .regex(
    /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
    "must be a plain npm package name",
  );

const restManifestSchema = z
  .object({
    kind: z.literal("rest"),
    ...header,
    ops: z.record(opName, restOpSchema).refine(hasAnOp, "a component needs at least one op"),
  })
  .strict();

const moduleManifestSchema = z
  .object({
    kind: z.literal("module"),
    ...header,
    entry: z
      .string()
      .regex(/^\.\/[A-Za-z0-9_./-]+$/, "must be a relative path starting with ./")
      .refine(
        (entry) => !entry.split("/").includes(".."),
        "must stay inside the component directory",
      ),
    deps: z.record(dependencyNameSchema, exactDependencySchema).optional(),
    ops: z.record(opName, moduleOpSchema).refine(hasAnOp, "a component needs at least one op"),
  })
  .strict();

// ---- Cross-field lint --------------------------------------------------------------------------------

// One reference grammar, shared in spirit with the engine's renderer: `{{ input.x }}`, `{{ config.x }}`
// and (only in an inject template) `{{ secret }}`, each with optional inner spaces. Anything else
// between braces is a lint error, so a malformed reference can never be sent to an API as literal text.
const BRACES = /\{\{([^{}]*)\}\}/g;
const ENV_REF = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

type Path = (string | number)[];

function stringsIn(value: unknown, path: Path = []): { text: string; path: Path }[] {
  if (typeof value === "string") return [{ text: value, path }];
  if (Array.isArray(value)) return value.flatMap((entry, i) => stringsIn(entry, [...path, i]));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => stringsIn(entry, [...path, key]));
  }
  return [];
}

function keysIn(value: unknown, path: Path = []): { key: string; path: Path }[] {
  if (Array.isArray(value)) return value.flatMap((entry, i) => keysIn(entry, [...path, i]));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => [
      { key, path: [...path, key] },
      ...keysIn(entry, [...path, key]),
    ]);
  }
  return [];
}

// Is `host` (a slot's host) inside what `egress` allows? Exact, or under a leading wildcard entry.
function coveredByEgress(host: string, egress: string[]): boolean {
  return egress.some((entry) => {
    if (entry === host) return true;
    if (!entry.startsWith("*.")) return false;
    const suffix = entry.slice(1); // ".example.com"
    return host.endsWith(suffix) || host === entry;
  });
}

function lintManifest(
  manifest: z.infer<typeof restManifestSchema> | z.infer<typeof moduleManifestSchema>,
  ctx: z.RefinementCtx,
): void {
  const configKeys = new Set(Object.keys(manifest.config ?? {}));
  const issue = (message: string, path: Path) => ctx.addIssue({ code: "custom", message, path });

  interface Scope {
    input: Set<string> | null; // null: input references are not available here
    config: boolean;
    secret: boolean;
  }

  const checkRefs = (text: string, path: Path, scope: Scope) => {
    for (const match of text.matchAll(BRACES)) {
      const inner = match[1]!.trim();
      if (inner === "secret") {
        if (!scope.secret) issue('"{{ secret }}" is only allowed in an auth inject template', path);
        continue;
      }
      const ref = /^(input|config)\.([A-Za-z0-9_]+)$/.exec(inner);
      if (!ref) {
        issue(`malformed reference "${match[0]}" (use {{ input.x }} or {{ config.x }})`, path);
      } else if (ref[1] === "input") {
        if (scope.input === null)
          issue(`"${match[0]}": input references are not available here`, path);
        else if (!scope.input.has(ref[2]!)) {
          issue(`refers to input.${ref[2]}, which this op does not declare`, path);
        }
      } else if (!scope.config) {
        issue(`"${match[0]}": config references are not available here`, path);
      } else if (!configKeys.has(ref[2]!)) {
        issue(`refers to config.${ref[2]}, which this component does not declare`, path);
      }
    }
    const leftover = text.replace(BRACES, "");
    if (leftover.includes("{{") || leftover.includes("}}")) {
      issue("unbalanced {{ }} in a reference", path);
    }
  };

  const hostScope: Scope = { input: null, config: true, secret: false };
  const egress = manifest.permissions?.egress ?? [];
  for (const [i, entry] of egress.entries())
    checkRefs(entry, ["permissions", "egress", i], hostScope);
  for (const [slotName, slot] of Object.entries(manifest.auth?.slots ?? {})) {
    for (const [i, host] of slot.hosts.entries()) {
      checkRefs(host, ["auth", "slots", slotName, "hosts", i], hostScope);
      if (manifest.permissions && !coveredByEgress(host, egress)) {
        issue(
          `slot host "${host}" is not covered by permissions.egress, so every call using this slot would be refused`,
          ["auth", "slots", slotName, "hosts", i],
        );
      }
    }
    if (slot.inject) {
      checkRefs(slot.inject.template, ["auth", "slots", slotName, "inject", "template"], {
        input: null,
        config: false,
        secret: true,
      });
    }
  }

  for (const [slotName, slot] of Object.entries(manifest.auth?.slots ?? {})) {
    if (!slot.probe) continue;
    const at = ["auth", "slots", slotName, "probe"];
    const op = Object.hasOwn(manifest.ops, slot.probe.op) ? manifest.ops[slot.probe.op] : undefined;
    if (!op) {
      issue(`probe names op "${slot.probe.op}", which this component does not have`, [...at, "op"]);
      continue;
    }
    // A probe is run to check a credential, so it must not change anything.
    if (op.effect !== "read") {
      issue(`probe op "${slot.probe.op}" must have effect: read`, [...at, "op"]);
    }
    if (manifest.kind === "rest") {
      const injected = (op as { slots?: string[] }).slots;
      const usesSlot = injected
        ? injected.includes(slotName)
        : manifest.auth?.slots[slotName]?.inject !== undefined;
      if (!usesSlot) {
        issue(
          `probe op "${slot.probe.op}" does not send slot "${slotName}", so it proves nothing`,
          [...at, "op"],
        );
      }
    }
    if (manifest.kind === "rest") {
      // The pipeline refuses a request to a host the slot is not bound to, so such a probe could never succeed.
      const url = (op as { request?: { url?: string } }).request?.url ?? "";
      if (!url.includes("{{")) {
        try {
          const host = new URL(url).host;
          if (!coveredByEgress(host, manifest.auth?.slots[slotName]?.hosts ?? [])) {
            issue(
              `probe op "${slot.probe.op}" calls ${host}, which slot "${slotName}" is not bound to`,
              [...at, "op"],
            );
          }
        } catch {
          // Not a literal URL; the op's own checks report it.
        }
      }
    }
    for (const key of op.input?.required ?? []) {
      if (!Object.hasOwn(slot.probe.with ?? {}, key)) {
        issue(`probe op "${slot.probe.op}" needs input "${key}"; give it under probe.with`, [
          ...at,
          "with",
        ]);
      }
    }
  }

  for (const [opKey, op] of Object.entries(manifest.ops)) {
    const inputKeys = new Set(Object.keys(op.input?.properties ?? {}));
    for (const key of op.fixture_key ?? []) {
      if (!inputKeys.has(key)) {
        issue(`fixture_key names "${key}", which is not an input property`, [
          "ops",
          opKey,
          "fixture_key",
        ]);
      }
    }
  }

  // A secret reaches code only through its slot; naming its variable as plain env would hand a module
  // the value without the host binding.
  const slotEnvs = new Set(Object.values(manifest.auth?.slots ?? {}).map((slot) => slot.env));
  for (const [i, name] of (manifest.permissions?.env ?? []).entries()) {
    if (SECRET_LOOKING.test(name)) {
      issue(
        `${name} looks like a secret; declare an auth slot for it, bound to the hosts it may be sent to, instead of plain env`,
        ["permissions", "env", i],
      );
    }
    if (slotEnvs.has(name)) {
      issue(`${name} is a secret slot's variable; read it through the slot, not as plain env`, [
        "permissions",
        "env",
        i,
      ]);
    }
  }

  if (manifest.kind !== "rest") return;
  const granted = manifest.permissions;
  if (
    granted &&
    (granted.env !== undefined || granted.fs !== undefined || granted.exec !== undefined)
  ) {
    issue("a rest component runs no code, so it cannot declare env, fs or exec", ["permissions"]);
  }
  if (!manifest.permissions || (manifest.permissions.egress ?? []).length === 0) {
    issue("a rest component must declare permissions.egress, or none of its requests can be sent", [
      "permissions",
    ]);
  }

  const injectable = Object.entries(manifest.auth?.slots ?? {}).filter(([, slot]) => slot.inject);
  for (const [opKey, op] of Object.entries(manifest.ops)) {
    const inputKeys = new Set(Object.keys(op.input?.properties ?? {}));
    const mode = op.response?.mode ?? "json";
    if (op.failure_when !== undefined && mode !== "json") {
      issue(`failure_when only applies to a json response (response mode is "${mode}")`, [
        "ops",
        opKey,
        "failure_when",
      ]);
    }

    // References are rendered in values only, so a reference in a name would be sent as literal text.
    for (const { text, path } of stringsIn(op.request, ["ops", opKey, "request"])) {
      if (ENV_REF.test(text)) {
        issue(
          "a manifest never holds an ${ENV} reference: declare an auth slot and let the engine inject it",
          path,
        );
      }
      checkRefs(text, path, { input: inputKeys, config: true, secret: false });
    }
    const named = [
      ...keysIn(op.request.headers, ["ops", opKey, "request", "headers"]),
      ...keysIn(op.request.query, ["ops", opKey, "request", "query"]),
      ...keysIn(op.request.body, ["ops", opKey, "request", "body"]),
    ];
    for (const { key, path } of named) {
      if (key.includes("{{") || key.includes("}}")) {
        issue("references are only supported in values, not in names or keys", path);
      }
    }

    // Which slots this op injects, and that they do not collide with each other or its own headers.
    const used = op.slots ?? injectable.map(([name]) => name);
    const seen = new Map<string, string>();
    for (const name of used) {
      const slot = manifest.auth?.slots[name];
      if (!slot?.inject) {
        issue(`slot "${name}" does not exist or has no inject rule`, ["ops", opKey, "slots"]);
        continue;
      }
      const target = `${slot.inject.header !== undefined ? "header" : "query"}:${(slot.inject.header ?? slot.inject.query)!.toLowerCase()}`;
      if (seen.has(target)) {
        issue(`slots "${seen.get(target)}" and "${name}" both inject ${target.replace(":", " ")}`, [
          "ops",
          opKey,
          "slots",
        ]);
      }
      seen.set(target, name);
      const clash = Object.keys(
        (slot.inject.header !== undefined ? op.request.headers : op.request.query) ?? {},
      ).find(
        (key) =>
          `${slot.inject!.header !== undefined ? "header" : "query"}:${key.toLowerCase()}` ===
          target,
      );
      if (clash !== undefined) {
        issue(`request sets ${clash}, which slot "${name}" also injects`, [
          "ops",
          opKey,
          "request",
        ]);
      }
    }
  }
}

export const componentManifestSchema = z
  .discriminatedUnion("kind", [restManifestSchema, moduleManifestSchema])
  .superRefine(lintManifest);

export type ComponentManifest = z.infer<typeof componentManifestSchema>;
export type RestComponentManifest = z.infer<typeof restManifestSchema>;
export type ModuleComponentManifest = z.infer<typeof moduleManifestSchema>;
export type RestOp = z.infer<typeof restOpSchema>;
export type ModuleOp = z.infer<typeof moduleOpSchema>;
export type OpEffect = z.infer<typeof effectSchema>;

export interface ComponentParseResult {
  success: boolean;
  manifest?: ComponentManifest;
  errors: SpecError[];
}

/** Parses and lints a manifest from YAML; never throws, and points errors at a line where it can. */
export function parseComponentManifest(source: string): ComponentParseResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, keepSourceTokens: true });
  if (doc.errors.length > 0) {
    return {
      success: false,
      errors: doc.errors.map((err) => ({
        path: [],
        message: err.message,
        line: err.linePos?.[0]?.line,
        column: err.linePos?.[0]?.col,
      })),
    };
  }
  const result = componentManifestSchema.safeParse(doc.toJS());
  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map((issue) => toSpecError(issue, doc, lineCounter)),
    };
  }
  return { success: true, manifest: result.data, errors: [] };
}
