// Vendored from packages/engine/src/component-core.ts as part of a `kampong export`
// -- see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. The
// only change from the source file is the type import, which now comes from
// the local ./spec-types.js rather than "@kampong/spec" (this project has no
// dependency on that package -- ADR-0002). From here on this file is yours: it
// will not be touched again by a future export.
//
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ComponentManifest, ModuleComponentManifest } from "./spec-types.js";
import type { ModuleContext, ModuleRunner } from "./component.js";

// The part of the component registry that does not touch the manifest parser or the file system scan
// (KAN-1884, KAN-1886): the interfaces, the module runner, layering and a registry baked in at export
// time. It is what an exported project vendors (ADR-0010); the directory scan lives in
// component-registry.ts and is not vendored.

export interface ResolvedComponent {
  manifest: ComponentManifest;
  /** `sha256:<hex>` over every file in the component directory (paths and contents). */
  digest: string;
  /** Absolute path of the component directory. */
  dir: string;
  /** The files the digest covers, when the registry read them (a directory scan does; a baked one does not). */
  files?: Map<string, Buffer>;
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

/** `kampong/*` is reserved for the components that ship with kampong (ADR-0025). */
export function isFirstPartyId(id: string): boolean {
  return id.startsWith("kampong/");
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
    private readonly options: { requirePins?: boolean } = {},
  ) {}

  async invoke(
    manifest: ModuleComponentManifest,
    op: string,
    input: Record<string, unknown>,
    ctx: ModuleContext,
  ): Promise<unknown> {
    const ref = `${manifest.id}@${manifest.version}`;
    // First-party components need no pin, so a lockfile that cannot be read must not stop one (a legacy
    // Slack tool never had a lockfile). Any other component still fails visibly.
    const pins = isFirstPartyId(manifest.id)
      ? await readPins(this.pins).catch(() => ({}) as Record<string, string>)
      : await readPins(this.pins);
    const expectedDigest = Object.hasOwn(pins, ref) ? pins[ref] : undefined;
    // The dispatcher checked the pin when it resolved the call; a pin removed since then must not turn
    // that into "no check".
    if (this.options.requirePins && expectedDigest === undefined && !isFirstPartyId(manifest.id)) {
      throw new ComponentResolutionError(
        `component ${ref} is not pinned in kampong.lock; review it and run \`kampong lock\` to pin it`,
      );
    }
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

/**
 * The user's components plus the ones that ship with kampong. A `kampong/*` id is answered by the
 * first-party registry alone and everything else by the user's, so a project's folder can never
 * stand in for, or shadow, a first-party component.
 */
export class LayeredComponentRegistry implements ComponentRegistry {
  constructor(
    private readonly user: ComponentRegistry,
    private readonly firstParty: ComponentRegistry,
  ) {}

  resolve(id: string, version: string, options?: ResolveOptions): Promise<ResolvedComponent> {
    return (isFirstPartyId(id) ? this.firstParty : this.user).resolve(id, version, options);
  }

  async list(): Promise<ComponentSummary[]> {
    const [user, firstParty] = await Promise.all([this.user.list(), this.firstParty.list()]);
    return [...firstParty, ...user.filter((c) => !isFirstPartyId(c.id))];
  }
}

/**
 * A registry whose components were resolved earlier and baked in, as an export does: no scan and no
 * re-hash at run time, only the lookup and the pin check. Verifying the files on disk against the
 * baked digests is the export's SBOM concern.
 */
export class StaticComponentRegistry implements ComponentRegistry {
  constructor(private readonly components: ResolvedComponent[]) {}

  async resolve(
    id: string,
    version: string,
    options: ResolveOptions = {},
  ): Promise<ResolvedComponent> {
    const ref = `${id}@${version}`;
    const found = this.components.find(
      (c) => c.manifest.id === id && c.manifest.version === version,
    );
    if (!found) {
      throw new ComponentResolutionError(
        `component ${ref} is not included in this project (it has: ${this.components.map((c) => `${c.manifest.id}@${c.manifest.version}`).join(", ") || "none"})`,
      );
    }
    if (options.expectedDigest !== undefined && options.expectedDigest !== found.digest) {
      throw new ComponentResolutionError(
        `component ${ref} does not match its pinned digest (expected ${options.expectedDigest}, found ${found.digest})`,
      );
    }
    return found;
  }

  async list(): Promise<ComponentSummary[]> {
    return this.components.map((c) => ({
      id: c.manifest.id,
      version: c.manifest.version,
      dir: c.dir,
      title: c.manifest.title,
    }));
  }
}
