import { createHash } from "node:crypto";
import {
  componentIdSchema,
  parseComponentManifest,
  scanModuleSources,
  exactVersionSchema,
  type AgentSpec,
  type ComponentManifest,
} from "@kampong/spec";

// What an export needs to carry components (KAN-1886). The exporter has no dependency on the engine, so
// the caller (the CLI) resolves the components and hands over their manifests, digests and files; this
// module decides which ones a spec needs and checks that what it was given is safe to write.

export interface ExportComponent {
  manifest: ComponentManifest;
  /** `sha256:<hex>` over the component's files, as the registry computed it. */
  digest: string;
  /** The component's files by path relative to its directory. Written byte for byte. */
  files: Record<string, string | Uint8Array>;
}

/** The first-party components the legacy tool kinds run on (ADR-0030); keep in step with desugarLegacyTool. */
const LEGACY_COMPONENTS = {
  slack_post_message: "kampong/slack@1.0.0",
  gmail_send: "kampong/gmail@1.0.0",
} as const;

/** Every `id@version` the spec needs: its component tools, and the first-party ones its legacy Slack and Gmail tools run on. */
export function requiredComponentRefs(
  spec: AgentSpec,
  options: { legacy?: boolean } = {},
): string[] {
  const refs = new Set<string>();
  for (const tool of spec.agent.tools ?? []) {
    if (tool.action === "component") refs.add(tool.use);
    else if (
      options.legacy !== false &&
      (tool.action === "slack_post_message" || tool.action === "gmail_send")
    ) {
      refs.add(LEGACY_COMPONENTS[tool.action]);
    }
  }
  return [...refs].sort();
}

/** The `id@version` of every component the spec names itself with `action: component`. */
export function explicitComponentRefs(spec: AgentSpec): string[] {
  return requiredComponentRefs(spec, { legacy: false });
}

/**
 * The digest of a component's files, computed the way the engine's registry does it (paths and contents,
 * sorted), so an export can check that what it was handed is what the digest says.
 */
export function digestOfFiles(files: Record<string, string | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    const content = files[path]!;
    const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    hash.update(`${path}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes) : bytes)
    .digest("hex");

/** `sha256` hex of each file, by path: what the SBOM and the startup check use to say which file changed. */
export function fileHashes(files: ExportComponent["files"]): Record<string, string> {
  return Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((path) => [path, sha256(files[path]!)]),
  );
}

export const refOf = (c: ExportComponent): string => `${c.manifest.id}@${c.manifest.version}`;

export class ExportMissingComponentsError extends Error {
  constructor(public readonly missing: string[]) {
    super(
      `This spec uses components that were not supplied to the export: ${missing.join(", ")}. ` +
        `Install them under components/ next to the spec (or use a first-party kampong/* component) and export again.`,
    );
    this.name = "ExportMissingComponentsError";
  }
}

/** A path inside a component directory: relative, forward slashes, no `.`/`..`/empty segment, no drive letter. */
export function isSafeRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes(":"))
    return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Picks the components the spec needs out of what was supplied, and checks each is safe to write. */
export function selectComponents(
  spec: AgentSpec,
  supplied: ExportComponent[] | undefined,
): ExportComponent[] {
  // Without any components supplied, a legacy Slack or Gmail tool exports as it did before components
  // existed (it runs on its own request builder); a component tool always needs its component.
  const needed = requiredComponentRefs(spec, { legacy: supplied !== undefined });
  if (needed.length === 0) return [];
  const byRef = new Map((supplied ?? []).map((c) => [refOf(c), c]));
  const missing = needed.filter((ref) => !byRef.has(ref));
  if (missing.length > 0) throw new ExportMissingComponentsError(missing);
  const chosen = needed.map((ref) => byRef.get(ref)!);
  for (const component of chosen) {
    const { id, version } = component.manifest;
    if (
      !componentIdSchema.safeParse(id).success ||
      !exactVersionSchema.safeParse(version).success
    ) {
      throw new Error(
        `Refusing to export component "${id}@${version}": not a valid id and version.`,
      );
    }
    for (const path of Object.keys(component.files)) {
      if (!isSafeRelativePath(path)) {
        throw new Error(
          `Refusing to export ${id}@${version}: unsafe file path ${JSON.stringify(path)} in the component.`,
        );
      }
    }
    // What is baked in and printed must describe what is copied: the digest must be the files' digest,
    // and the manifest the one in the component's own component.yaml.
    const actual = digestOfFiles(component.files);
    if (actual !== component.digest) {
      throw new Error(
        `Refusing to export ${id}@${version}: its digest ${component.digest} does not match its files (${actual}).`,
      );
    }
    // The code must stay inside what the manifest declares (a static check, not a sandbox: ADR-0031).
    if (component.manifest.kind === "module") {
      const violations = scanModuleSources(component.manifest, component.files);
      if (violations.length > 0) {
        const shown = violations.slice(0, 5).map((v) => `${v.file}:${v.line} ${v.capability}`);
        throw new Error(
          `Refusing to export ${id}@${version}: its code does not stay inside its manifest (${shown.join(", ")}).`,
        );
      }
    }
    const manifestFile = component.files["component.yaml"];
    const parsed =
      manifestFile === undefined
        ? undefined
        : parseComponentManifest(Buffer.from(manifestFile).toString("utf8")).manifest;
    if (!parsed || JSON.stringify(parsed) !== JSON.stringify(component.manifest)) {
      throw new Error(
        `Refusing to export ${id}@${version}: its manifest is not the one in the component's own component.yaml.`,
      );
    }
  }
  return chosen;
}

/** The module that builds the exported project's component dispatcher from the baked manifests. */
export function buildComponentsModule(components: ExportComponent[]): string {
  const baked = components.map((c) => ({
    manifest: c.manifest,
    digest: c.digest,
    path: `${c.manifest.id}/${c.manifest.version}`,
    files: fileHashes(c.files),
  }));
  return `// Generated by \`kampong export\`. The components this project uses, as resolved at export time:
// their manifests (already parsed and linted) and the digest of the files copied under components/.
// Everything under src/runtime/ that reads these is vendored engine code (docs/adr/0010).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createComponentDispatcher } from "./runtime/component-dispatch.js";
import { InProcessModuleRunner, StaticComponentRegistry } from "./runtime/component-core.js";
import { verifyComponents } from "./runtime/component-verify.js";
import type { ComponentManifest } from "./runtime/spec-types.js";

// components/ sits at the project root, one level above both src/ and dist/.
const COMPONENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "components");

const BAKED: { manifest: ComponentManifest; digest: string; path: string; files: Record<string, string> }[] = ${JSON.stringify(baked, null, 2)};

// Refuse to start on components that are not the ones exported: re-hash every file under components/ and
// compare with the digests above. A tampered or missing file stops the project here, before any run.
await verifyComponents(
  BAKED.map(({ manifest, digest, path, files }) => ({
    ref: \`\${manifest.id}@\${manifest.version}\`,
    digest,
    path,
    files,
  })),
  COMPONENTS_DIR,
);

const registry = new StaticComponentRegistry(
  BAKED.map(({ manifest, digest, path }) => ({
    manifest,
    digest,
    dir: join(COMPONENTS_DIR, ...path.split("/")),
  })),
);

export const components = createComponentDispatcher({
  registry,
  runner: new InProcessModuleRunner(registry),
});
`;
}
