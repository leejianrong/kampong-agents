import type { ComponentDispatcher, ComponentTool } from "./workflow.js";
import { readPins } from "./component-registry.js";
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
      if (requirePins && expectedDigest === undefined) {
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
          invokeOp(manifest, tool.op, input, {
            config: tool.config,
            secretEnv: tool.secrets,
            runner,
            ...runtime,
          }),
      };
    },
  };
}
