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

// ---- A small JSON Schema subset ------------------------------------------------------------------
// Enough to validate an op's input and drive a generated canvas form. `.strict()` makes an unsupported
// keyword (oneOf, $ref, ...) a loud lint error instead of a silently ignored one.

export interface SchemaNode {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  title?: string;
  description?: string;
  default?: string | number | boolean;
  enum?: (string | number | boolean)[];
  format?: "multiline";
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
}

const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const schemaNodeSchema: z.ZodType<SchemaNode> = z.lazy(() =>
  z
    .object({
      type: z.enum(["string", "number", "integer", "boolean", "object", "array"]),
      title: z.string().optional(),
      description: z.string().optional(),
      default: scalar.optional(),
      enum: z.array(scalar).min(1).optional(),
      format: z.literal("multiline").optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(0).optional(),
      pattern: z
        .string()
        .refine((p) => {
          try {
            new RegExp(p);
            return true;
          } catch {
            return false;
          }
        }, "not a valid regular expression")
        .optional(),
      properties: z.record(z.string().regex(NAME), schemaNodeSchema).optional(),
      required: z.array(z.string()).optional(),
      items: schemaNodeSchema.optional(),
    })
    .strict()
    .superRefine((node, ctx) => {
      for (const name of node.required ?? []) {
        if (!node.properties || !(name in node.properties)) {
          ctx.addIssue({
            code: "custom",
            message: `required property "${name}" is not declared in properties`,
            path: ["required"],
          });
        }
      }
    }),
);

// ---- Permissions and auth --------------------------------------------------------------------------

// A host, optionally `host:port`, optionally a single leading `*.` wildcard, optionally referring to
// a config value (`{{ config.project }}.supabase.co`). Never a URL and never a bare wildcard.
const egressEntrySchema = z
  .string()
  .regex(/^[A-Za-z0-9.*{}_ :-]+$/, "must be a host or host:port, not a URL")
  .refine((entry) => !entry.includes("*") || /^\*\.[^*]+$/.test(entry), {
    message: 'a wildcard is only allowed as a leading "*." (for example *.example.com)',
  });

const permissionsSchema = z.object({ egress: z.array(egressEntrySchema).min(1) }).strict();

const slotSchema = z
  .object({
    /** The environment variable read by default; a spec can remap it. */
    env: z.string().regex(NAME, "must be an environment variable name such as SLACK_BOT_TOKEN"),
    /** The only hosts this secret may be sent to. */
    hosts: z.array(egressEntrySchema).min(1),
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
        if (!inject.template.includes("{{ secret }}")) {
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

const configParamSchema = z
  .object({
    type: z.literal("string"),
    title: z.string().optional(),
    description: z.string().optional(),
    default: z.string().optional(),
    /** Config values can end up in a host name, so the default pattern is restrictive. */
    pattern: z.string().optional(),
  })
  .strict();

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
  .regex(/^\d+\.\d+\.\d+$/, "must be an exact version such as 1.2.3 (no range, tag, URL or path)");

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
    deps: z.record(z.string().min(1), exactDependencySchema).optional(),
    ops: z.record(opName, moduleOpSchema).refine(hasAnOp, "a component needs at least one op"),
  })
  .strict();

// ---- Cross-field lint --------------------------------------------------------------------------------

const REF = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z0-9_]+))?\s*\}\}/g;
const ENV_REF = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

function stringsIn(
  value: unknown,
  path: (string | number)[] = [],
): { text: string; path: (string | number)[] }[] {
  if (typeof value === "string") return [{ text: value, path }];
  if (Array.isArray(value)) return value.flatMap((entry, i) => stringsIn(entry, [...path, i]));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => stringsIn(entry, [...path, key]));
  }
  return [];
}

function lintManifest(
  manifest: z.infer<typeof restManifestSchema> | z.infer<typeof moduleManifestSchema>,
  ctx: z.RefinementCtx,
): void {
  const configKeys = new Set(Object.keys(manifest.config ?? {}));

  const checkRefs = (
    text: string,
    path: (string | number)[],
    inputKeys: Set<string>,
    inInject: boolean,
  ) => {
    for (const match of text.matchAll(REF)) {
      const [, scope, key] = match;
      if (scope === "secret" && key === undefined) {
        if (!inInject) {
          ctx.addIssue({
            code: "custom",
            message: '"{{ secret }}" is only allowed in an auth inject template',
            path,
          });
        }
      } else if (scope === "input" && key !== undefined) {
        if (!inputKeys.has(key)) {
          ctx.addIssue({
            code: "custom",
            message: `refers to input.${key}, which this op does not declare`,
            path,
          });
        }
      } else if (scope === "config" && key !== undefined) {
        if (!configKeys.has(key)) {
          ctx.addIssue({
            code: "custom",
            message: `refers to config.${key}, which this component does not declare`,
            path,
          });
        }
      } else {
        ctx.addIssue({
          code: "custom",
          message: `unknown reference "${match[0]}" (use {{ input.x }} or {{ config.x }})`,
          path,
        });
      }
    }
  };

  for (const [i, entry] of (manifest.permissions?.egress ?? []).entries()) {
    checkRefs(entry, ["permissions", "egress", i], new Set(), false);
  }
  for (const [slotName, slot] of Object.entries(manifest.auth?.slots ?? {})) {
    for (const [i, host] of slot.hosts.entries()) {
      checkRefs(host, ["auth", "slots", slotName, "hosts", i], new Set(), false);
    }
    if (slot.inject)
      checkRefs(
        slot.inject.template,
        ["auth", "slots", slotName, "inject", "template"],
        new Set(),
        true,
      );
  }

  for (const [opKey, op] of Object.entries(manifest.ops)) {
    const inputKeys = new Set(Object.keys(op.input?.properties ?? {}));
    for (const key of op.fixture_key ?? []) {
      if (!inputKeys.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `fixture_key names "${key}", which is not an input property`,
          path: ["ops", opKey, "fixture_key"],
        });
      }
    }
  }

  if (manifest.kind !== "rest") return;
  if (!manifest.permissions) {
    ctx.addIssue({
      code: "custom",
      message:
        "a rest component must declare permissions.egress, or none of its requests can be sent",
      path: ["permissions"],
    });
  }
  for (const [opKey, op] of Object.entries(manifest.ops)) {
    const inputKeys = new Set(Object.keys(op.input?.properties ?? {}));
    const mode = op.response?.mode ?? "json";
    if (op.failure_when !== undefined && mode !== "json") {
      ctx.addIssue({
        code: "custom",
        message: `failure_when only applies to a json response (response mode is "${mode}")`,
        path: ["ops", opKey, "failure_when"],
      });
    }
    for (const { text, path } of stringsIn(op.request, ["ops", opKey, "request"])) {
      if (ENV_REF.test(text)) {
        ctx.addIssue({
          code: "custom",
          message:
            "a manifest never holds an ${ENV} reference: declare an auth slot and let the engine inject it",
          path,
        });
      }
      checkRefs(text, path, inputKeys, false);
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
