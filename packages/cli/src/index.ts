// Library barrel for @kampong/cli (PLAN.md Shape S5, ADR-0005/0007): the
// dev server, spec store, file watcher, and run manager the actual CLI
// entry point (cli.ts, package.json's `bin`) is built on top of. Kept
// separate from cli.ts deliberately -- importing this module (as
// apps/canvas's tests do, for `createDevServer`) must never have the side
// effect of parsing argv or starting a process; only running cli.ts
// directly does that. `kampong export` (SLICES.md V4) is still out of
// scope here.

export const PACKAGE_NAME = "@kampong/cli";

export { createDevServer, type CreateDevServerOptions } from "./server.js";
export { SpecStore } from "./spec-store.js";
export { SpecFileWatcher, type FileWatchEvent, type WatchEventType } from "./file-watcher.js";
export { classifyFileChange, type FileChangeClassification } from "./watch-decision.js";
export { RunManager, type RunManagerOptions, type StartRunResult } from "./run-manager.js";
