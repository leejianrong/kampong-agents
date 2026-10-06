import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseComponentManifest,
  type ComponentManifest,
  type ModuleComponentManifest,
} from "@kampong/spec";
import type { ModuleContext, ModuleRunner } from "./component.js";

// The component registry (KAN-1884, ADR-0025 and ADR-0029): turns the `id@version` a spec names into a
// parsed manifest plus the digest of the exact bytes it was read from. The directory implementation
// scans a components folder; the lockfile that records digests and the folder layout are KAN-1834, so
// this only offers the check (`expectedDigest`).

export interface ResolvedComponent {
  manifest: ComponentManifest;
  /** `sha256:<hex>` over every file in the component directory (paths and contents). */
  digest: string;
  /** Absolute path of the component directory. */
  dir: string;
}

export interface ComponentSummary {
  id: string;
  version: string;
  dir: string;
  title?: string;
}

export interface ResolveOptions {
  /** A digest recorded earlier (kampong.lock); resolution fails if the bytes on disk no longer match. */
  expectedDigest?: string;
}

export interface ComponentRegistry {
  resolve(id: string, version: string, options?: ResolveOptions): Promise<ResolvedComponent>;
  list(): Promise<ComponentSummary[]>;
}

/** Pins as a fixed map, or a function read on each use. */
export type PinSource =
  Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

export async function readPins(source: PinSource): Promise<Record<string, string>> {
  return typeof source === "function" ? await source() : source;
}

export class ComponentResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComponentResolutionError";
  }
}

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
      const broken =
        problems.length > 0
          ? `; ${problems.length} manifest(s) failed to load, see problems()`
          : "";
      throw new ComponentResolutionError(`component ${ref} was not found (${hint}${broken})`);
    }
    const dir = matches[0]!.dir;
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
    }
    return { manifest, digest, dir };
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

/**
 * Runs `kind: module` components by importing their entry in this process. It is not a sandbox: the
 * module gets the permission-checked `ctx` but could still reach Node directly, so only reviewed
 * modules should be installed (ADR-0026). Each call re-resolves the component, which re-hashes the
 * directory, so an entry edited after a pin fails the pin instead of running. Only the entry file
 * is re-imported when it changes (the URL carries its digest); a helper it imports stays cached
 * until the process restarts.
 */
export class InProcessModuleRunner implements ModuleRunner {
  constructor(
    private readonly registry: ComponentRegistry,
    /** `id@version` to the digest it must match (from kampong.lock). */
    private readonly pins: PinSource = {},
  ) {}

  async invoke(
    manifest: ModuleComponentManifest,
    op: string,
    input: Record<string, unknown>,
    ctx: ModuleContext,
  ): Promise<unknown> {
    const ref = `${manifest.id}@${manifest.version}`;
    const pins = await readPins(this.pins);
    const expectedDigest = Object.hasOwn(pins, ref) ? pins[ref] : undefined;
    const resolved = await this.registry.resolve(manifest.id, manifest.version, { expectedDigest });
    if (resolved.manifest.kind !== "module") {
      throw new ComponentResolutionError(`${ref} is not a module component`);
    }
    // Approval, egress and slot checks were made against the manifest the caller resolved. If the file
    // has changed since, those checks describe a different component, so refuse rather than run it.
    if (JSON.stringify(resolved.manifest) !== JSON.stringify(manifest)) {
      throw new ComponentResolutionError(
        `${ref}: the manifest changed on disk after it was resolved; re-run so its permissions are checked again`,
      );
    }
    const entry = resolved.manifest.entry;
    if (![".js", ".mjs", ".cjs"].includes(extname(entry))) {
      throw new ComponentResolutionError(
        `${ref}: entry ${entry} must be compiled JavaScript (.js or .mjs); TypeScript entries are not loaded directly`,
      );
    }
    const url = `${pathToFileURL(join(resolved.dir, entry)).href}?digest=${resolved.digest.slice(7)}`;
    const mod = (await import(url)) as { invoke?: unknown };
    if (typeof mod.invoke !== "function") {
      throw new ComponentResolutionError(
        `${ref}: entry ${entry} does not export an invoke function`,
      );
    }
    return await (
      mod.invoke as (op: string, input: unknown, ctx: ModuleContext) => Promise<unknown>
    )(op, input, ctx);
  }
}
