// TypeScript codegen: AgentSpec -> standalone, runnable Mastra project
// (PLAN.md Shape S6, ADR-0002: one-way export, never re-imported;
// docs/adr/0010: the exported runtime is vendored engine source, not a
// re-templated reimplementation). SLICES.md V4, KAN-1114.

export const PACKAGE_NAME = "@kampong/exporter";

export { exportProject, type ExportResult } from "./project.js";
export { buildPackageJson, slugifyPackageName } from "./package-json.js";
export { buildEntryPointSource } from "./entry-point.js";
export { buildReadme } from "./readme.js";
export {
  buildTsconfig,
  buildGitignore,
  buildEnvExample,
  collectRequiredEnvVars,
} from "./project-files.js";
export { readRuntimeFiles, type RuntimeFile } from "./runtime-files.js";
