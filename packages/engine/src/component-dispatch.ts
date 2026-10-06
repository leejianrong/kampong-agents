import type { ComponentDispatcher, ComponentTool } from "./workflow.js";
import { invokeOp, opRequiresApproval, type ModuleRunner } from "./component.js";
import type { ComponentRegistry } from "./component-registry.js";

// Connects the workflow's `action: component` tools to a registry and runner (KAN-1884). Kept out of
// workflow.ts so that file, which exports vendor, has no dependency on the component machinery.

export interface CreateComponentDispatcherOptions {
  registry: ComponentRegistry;
  /** Runs `kind: module` components; a rest component needs none. */
  runner?: ModuleRunner;
  /** `id@version` to the digest it must match (kampong.lock, KAN-1834). */
  pins?: Record<string, string>;
}

export function createComponentDispatcher({
  registry,
  runner,
  pins = {},
}: CreateComponentDispatcherOptions): ComponentDispatcher {
  return {
    async prepare(tool: ComponentTool) {
      // `use` is validated as id@version by the spec schema; split on the last "@" regardless.
      const at = tool.use.lastIndexOf("@");
      const { manifest } = await registry.resolve(tool.use.slice(0, at), tool.use.slice(at + 1), {
        expectedDigest: Object.hasOwn(pins, tool.use) ? pins[tool.use] : undefined,
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
