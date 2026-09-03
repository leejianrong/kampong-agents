// PLAN.md Shape S5 (ADR-0005/0007): the local server `kampong dev` starts.
// The full CLI command surface (argument parsing, `kampong run`,
// `kampong export`, JSON output, exit codes) is SLICES.md V3/V4 scope;
// what V1 needs is a server the canvas can talk to during development,
// which is what's exported here.

export const PACKAGE_NAME = "@kampong/cli";

export { createDevServer, type CreateDevServerOptions } from "./server.js";
export { SpecStore } from "./spec-store.js";
export { SpecFileWatcher, type FileWatchEvent } from "./file-watcher.js";
export { classifyFileChange, type FileChangeClassification } from "./watch-decision.js";
export { RunManager, type RunManagerOptions, type StartRunResult } from "./run-manager.js";
