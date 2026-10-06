import { dirname, join } from "node:path";
import {
  createComponentDispatcher,
  DirectoryComponentRegistry,
  InProcessModuleRunner,
  type ComponentDispatcher,
} from "@kampong/engine";

// Where a spec's components live (KAN-1884): a `components/` folder next to the spec file. The wider
// layout and the lockfile that pins digests are KAN-1834; until then there are no pins, so the digest
// is computed but not enforced.
export function componentsDirFor(specPath: string): string {
  return join(dirname(specPath), "components");
}

export function componentDispatcherFor(specPath: string): ComponentDispatcher {
  const registry = new DirectoryComponentRegistry(componentsDirFor(specPath));
  return createComponentDispatcher({ registry, runner: new InProcessModuleRunner(registry) });
}
