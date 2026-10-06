import type { ComponentManifest, SchemaNode } from "@kampong/spec";
import type { ComponentDispatcher, ComponentTool } from "./workflow.js";
import { isFirstPartyId, readPins } from "./component-registry.js";
import { invokeOp, opRequiresApproval, type ModuleRunner } from "./component.js";
import type { ComponentRegistry, PinSource } from "./component-registry.js";

// Connects the workflow's `action: component` tools to a registry and runner (KAN-1884). Kept out of
// workflow.ts so that file, which exports vendor, has no dependency on the component machinery.

export interface CreateComponentDispatcherOptions {
  registry: ComponentRegistry;
  /** Runs `kind: module` components; a rest component needs none. */
  runner?: ModuleRunner;
  /**
   * `id@version` to the digest it must match (kampong.lock, KAN-1834). A function is read again on
   * every call, so a lockfile edited while `kampong dev` is running takes effect without a restart.
   */
  pins?: PinSource;
  /** When true, a component with no pin is refused instead of run unchecked. */
  requirePins?: boolean;
}

export function createComponentDispatcher({
  registry,
  runner,
  pins = {},
  requirePins = false,
}: CreateComponentDispatcherOptions): ComponentDispatcher {
  return {
    async prepare(tool: ComponentTool) {
      // `use` is validated as id@version by the spec schema; split on the last "@" regardless.
      const at = tool.use.lastIndexOf("@");
      const current = await readPins(pins);
      const expectedDigest = Object.hasOwn(current, tool.use) ? current[tool.use] : undefined;
      if (requirePins && expectedDigest === undefined && !isFirstPartyId(tool.use)) {
        throw new Error(
          `component ${tool.use} is not pinned in kampong.lock; review it and run \`kampong lock\` to pin it`,
        );
      }
      const { manifest } = await registry.resolve(tool.use.slice(0, at), tool.use.slice(at + 1), {
        expectedDigest,
      });
      return {
        requiresApproval: opRequiresApproval(manifest, tool.op, tool.requires_approval),
        run: (input, runtime) =>
          invokeOp(
            manifest,
            tool.op,
            coerceTemplated(inputSchemaOf(manifest, tool.op), input, tool.with),
            {
              config: tool.config,
              secretEnv: tool.secrets,
              runner,
              ...runtime,
            },
          ),
      };
    },
  };
}

function inputSchemaOf(manifest: ComponentManifest, op: string): SchemaNode | undefined {
  return Object.hasOwn(manifest.ops, op) ? manifest.ops[op]!.input : undefined;
}

// A `{{ reference }}` in `with` always arrives as text, even where the op declares a number or a
// boolean (the canvas form lets a numeric field take a reference). Convert a string to the declared
// type only when it is unambiguous: plain decimal digits, or exactly true/false. Anything else is left
// as text, so validation names the field instead of the engine guessing.
const DECIMAL = /^-?\d+(\.\d+)?$/;

const REFERENCE = /\{\{[^}]*\}\}/;

function coerceValue(schema: SchemaNode, value: unknown, raw: unknown): unknown {
  // Only a value the author wrote as a reference is converted; a literal "5" for an integer stays text
  // and fails validation, as it always did.
  if (typeof value === "string" && typeof raw === "string" && REFERENCE.test(raw)) {
    if ((schema.type === "number" || schema.type === "integer") && DECIMAL.test(value)) {
      const n = Number(value);
      // A digit string beyond 2^53 would silently lose precision; leave it for validation to reject.
      return Number.isInteger(n) && !Number.isSafeInteger(n) ? value : n;
    }
    if (schema.type === "boolean" && (value === "true" || value === "false")) {
      return value === "true";
    }
    return value;
  }
  if (
    schema.type === "object" &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return coerceTemplated(schema, value as Record<string, unknown>, raw);
  }
  return value;
}

export function coerceTemplated(
  schema: SchemaNode | undefined,
  input: Record<string, unknown>,
  raw: unknown,
): Record<string, unknown> {
  if (!schema?.properties) return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      Object.hasOwn(schema.properties!, key)
        ? coerceValue(
            schema.properties![key]!,
            value,
            raw !== null && typeof raw === "object" && Object.hasOwn(raw, key)
              ? (raw as Record<string, unknown>)[key]
              : undefined,
          )
        : value,
    ]),
  );
}
