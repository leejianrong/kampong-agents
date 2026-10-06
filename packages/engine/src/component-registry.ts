import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseComponentManifest, scanModuleSources, type ComponentManifest } from "@kampong/spec";
import {
  ComponentResolutionError,
  type ComponentRegistry,
  type ComponentSummary,
  type ResolvedComponent,
  type ResolveOptions,
} from "./component-core.js";

export * from "./component-core.js";

// The directory component registry (KAN-1884, ADR-0025 and ADR-0029): turns the `id@version` a spec
// names into a parsed manifest plus the digest of the exact bytes it was read from, by scanning a
// components folder laid out `<namespace>/<name>/<version>/` (KAN-1834). The interfaces, the module
// runner and layering are in component-core.ts, which exports vendor.

export interface ComponentProblem {
  dir: string;
  message: string;
}

const MANIFEST_FILE = "component.yaml";
const MAX_SCAN_DEPTH = 5;
const MAX_FILES = 2_000;
const MAX_BYTES = 50 * 1024 * 1024;

interface Found extends ComponentSummary {
  manifest: ComponentManifest;
}

export interface DirectoryComponentRegistryOptions {
  /**
   * True for the first-party root that ships with kampong. Only that root may hold `kampong/*`
   * components (ADR-0025); a user's own `components/` folder claiming the namespace is impersonation.
   */
  firstParty?: boolean;
}

/**
 * Components live at `<root>/<namespace>/<name>/<version>/component.yaml`. A manifest anywhere else is
 * reported, not registered: the path is how a reviewer finds a component, so it must say what the
 * manifest says.
 */
export class DirectoryComponentRegistry implements ComponentRegistry {
  constructor(
    private readonly root: string,
    private readonly options: DirectoryComponentRegistryOptions = {},
  ) {}

  /** Manifests that exist but did not load, so a broken component is reported rather than hidden. */
  async problems(): Promise<ComponentProblem[]> {
    return (await this.scan()).problems;
  }

  async list(): Promise<ComponentSummary[]> {
    const { found } = await this.scan();
    return found.map(({ id, version, dir, title }) => ({ id, version, dir, title }));
  }

  async resolve(
    id: string,
    version: string,
    options: ResolveOptions = {},
  ): Promise<ResolvedComponent> {
    const ref = `${id}@${version}`;
    const { found, problems } = await this.scan();
    const matches = found.filter((c) => c.id === id && c.version === version);
    if (matches.length > 1) {
      throw new ComponentResolutionError(
        `${ref} is declared by more than one component directory (${matches.map((m) => relative(this.root, m.dir)).join(", ")})`,
      );
    }
    if (matches.length === 0) {
      const same = found.filter((c) => c.id === id).map((c) => `${c.id}@${c.version}`);
      const hint =
        same.length > 0
          ? `available: ${same.join(", ")}`
          : `no component with id ${id} under ${this.root}`;
      // Say why, not just how many: a manifest in the wrong place or one that does not parse is the
      // usual reason a component "is not found", and nothing else prints problems().
      const shown = problems.slice(0, 3).map((p) => p.message);
      const broken =
        problems.length > 0
          ? `; ${problems.length} manifest(s) were not loaded: ${shown.join(" | ")}${problems.length > 3 ? " | ..." : ""}`
          : "";
      throw new ComponentResolutionError(`component ${ref} was not found (${hint}${broken})`);
    }
    return this.load(matches[0]!.dir, id, version, options);
  }

  /**
   * Every component with its manifest and digest, from one scan. For a listing (the canvas catalog);
   * a component that fails to load is reported as a problem next to the others, not thrown.
   */
  async resolveAll(): Promise<{ components: ResolvedComponent[]; problems: string[] }> {
    const { found, problems } = await this.scan();
    const components: ResolvedComponent[] = [];
    const messages = problems.map((p) => p.message);
    for (const entry of found) {
      try {
        components.push(await this.load(entry.dir, entry.id, entry.version, {}));
      } catch (err) {
        messages.push(`${entry.id}@${entry.version}: ${(err as Error).message}`);
      }
    }
    return { components, problems: messages };
  }

  /** Reads, hashes and parses one component directory, then applies the pin and entry checks. */
  private async load(
    dir: string,
    id: string,
    version: string,
    options: ResolveOptions,
  ): Promise<ResolvedComponent> {
    const ref = `${id}@${version}`;
    let hashed: Awaited<ReturnType<typeof hashDirectory>>;
    try {
      hashed = await hashDirectory(dir);
    } catch (err) {
      if (err instanceof ComponentResolutionError) throw err;
      throw new ComponentResolutionError(
        `component ${ref} could not be read (${(err as Error).message}); it may have been edited while resolving`,
      );
    }
    const { digest, files } = hashed;

    // Parse the very bytes the digest covers, so a file swapped between hashing and parsing cannot
    // yield a manifest the digest does not describe.
    const bytes = files.get(MANIFEST_FILE);
    const parsed = bytes ? parseComponentManifest(bytes.toString("utf8")) : undefined;
    const manifest = parsed?.manifest;
    if (!bytes) {
      throw new ComponentResolutionError(`component ${ref} has no ${MANIFEST_FILE}`);
    }
    if (!manifest || manifest.id !== id || manifest.version !== version) {
      throw new ComponentResolutionError(
        `component ${ref} changed on disk while it was being read`,
      );
    }
    if (options.expectedDigest !== undefined && options.expectedDigest !== digest) {
      throw new ComponentResolutionError(
        `component ${ref} does not match its pinned digest (expected ${options.expectedDigest}, found ${digest})`,
      );
    }
    if (manifest.kind === "module") {
      const entry = manifest.entry.replace(/^\.\//, "");
      if (!files.has(entry)) {
        throw new ComponentResolutionError(
          `component ${ref} names entry ${manifest.entry}, which is not a file in ${dir}`,
        );
      }
      // The code must stay inside what the manifest declares (a static check, not a sandbox: ADR-0031).
      // Refused here, before any of it is imported, so a violating module never runs.
      const violations = scanModuleSources(manifest, Object.fromEntries(files));
      if (violations.length > 0) {
        const shown = violations
          .slice(0, 5)
          .map((v) => `${v.file}:${v.line} ${v.capability}: ${v.message}`);
        throw new ComponentResolutionError(
          `component ${ref} does not stay inside its manifest: ${shown.join("; ")}${violations.length > 5 ? `; and ${violations.length - 5} more` : ""}`,
        );
      }
    }
    return { manifest, digest, dir, files };
  }

  private async scan(): Promise<{ found: Found[]; problems: ComponentProblem[] }> {
    const found: Found[] = [];
    const problems: ComponentProblem[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.name === MANIFEST_FILE && e.isFile())) {
        try {
          const source = await readFile(join(dir, MANIFEST_FILE), "utf8");
          const parsed = parseComponentManifest(source);
          const rel = relative(this.root, dir).split(sep).join("/");
          const expected = parsed.manifest
            ? `${parsed.manifest.id}/${parsed.manifest.version}`
            : undefined;
          if (parsed.manifest && rel !== expected) {
            problems.push({
              dir,
              message: `${rel || "."}: ${parsed.manifest.id}@${parsed.manifest.version} must live at ${expected}`,
            });
          } else if (
            parsed.manifest &&
            !this.options.firstParty &&
            parsed.manifest.id.startsWith("kampong/")
          ) {
            problems.push({
              dir,
              message: `${rel}: the kampong/* namespace is reserved for first-party components`,
            });
          } else if (parsed.manifest) {
            found.push({
              id: parsed.manifest.id,
              version: parsed.manifest.version,
              title: parsed.manifest.title,
              dir,
              manifest: parsed.manifest,
            });
          } else {
            const first = parsed.errors[0];
            problems.push({
              dir,
              message: `${relative(this.root, dir) || "."}: ${first?.message ?? "invalid manifest"}${first?.line ? ` (line ${first.line})` : ""}`,
            });
          }
        } catch (err) {
          problems.push({ dir, message: `${relative(this.root, dir)}: ${(err as Error).message}` });
        }
        return; // a component directory is a leaf: do not look for components inside one
      }
      if (depth >= MAX_SCAN_DEPTH) return;
      for (const entry of entries) {
        // Real directories only: a symlink could lead outside the components root.
        if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith("."))
          continue;
        await visit(join(dir, entry.name), depth + 1);
      }
    };
    await visit(this.root, 0);
    return { found, problems };
  }
}

async function hashDirectory(dir: string): Promise<{ digest: string; files: Map<string, Buffer> }> {
  const files = new Map<string, Buffer>();
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      // Installed dependencies are pinned by exact version in the manifest's `deps` and installed
      // from a lockfile (KAN-1834); hashing them would make every `npm install` change the digest,
      // trip the file cap, and choke on `.bin` symlinks.
      if (entry.name === "node_modules" || entry.name === ".DS_Store") continue;
      const full = join(current, entry.name);
      const rel = relative(dir, full).split(sep).join("/");
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) {
        throw new ComponentResolutionError(
          `${rel} in ${dir} is a symlink; components must be self-contained real files`,
        );
      }
      if (stat.isDirectory()) {
        await walk(full);
      } else if (stat.isFile()) {
        total += stat.size;
        if (files.size >= MAX_FILES || total > MAX_BYTES) {
          throw new ComponentResolutionError(`${dir} is too large to be a component`);
        }
        files.set(rel, await readFile(full));
      } else {
        throw new ComponentResolutionError(`${rel} in ${dir} is not a regular file`);
      }
    }
  };
  await walk(dir);
  const hash = createHash("sha256");
  for (const rel of [...files.keys()].sort()) {
    hash.update(`${rel}\0${createHash("sha256").update(files.get(rel)!).digest("hex")}\n`);
  }
  return { digest: `sha256:${hash.digest("hex")}`, files };
}

/** The components that ship with this package, under `packages/engine/components`. */
export function createFirstPartyRegistry(): DirectoryComponentRegistry {
  // `src/` and `dist/` are both one level below the package root, so this holds for either.
  // Built from the module's own path as a string: `new URL(...)` would be the DOM's URL class under a
  // jsdom test environment, which Node's fileURLToPath rejects.
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "components");
  return new DirectoryComponentRegistry(dir, { firstParty: true });
}
