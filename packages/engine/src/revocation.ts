import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findRevocation,
  parseRegistryIndex,
  parseRevocations,
  type RegistryIndex,
  type Revocation,
} from "@kampong/spec";
import {
  ComponentResolutionError,
  type ComponentRegistry,
  type ComponentSummary,
  type ResolvedComponent,
  type ResolveOptions,
} from "./component-core.js";

// Revocation (KAN-1838, ADR-0026 and ADR-0037). A registry index can mark a component version as revoked
// (a malicious update, a leaked credential, a vulnerability). A run, a pin and the canvas then refuse those
// bytes, wherever the component came from. It sits outside component-core.ts, so it is not part of what an
// export vendors: an exported project cannot be revoked remotely (ADR-0026, threat T9).

export class RevokedComponentError extends ComponentResolutionError {
  constructor(
    public readonly ref: string,
    public readonly revocation: Revocation,
  ) {
    super(
      `component ${ref} was revoked on ${revocation.at}: ${revocation.reason}` +
        (revocation.advisory ? ` (${revocation.advisory})` : "") +
        `. Remove it, or use a version that has not been revoked.`,
    );
    this.name = "RevokedComponentError";
  }
}

/** Where a project may add revocations of its own, beside `.kampong/layout.json`. */
export const PROJECT_REGISTRY_INDEX = join(".kampong", "registry-index.json");

/** The index that ships with this package, under `packages/engine/components`. */
export function shippedRegistryIndexPath(): string {
  // `src/` and `dist/` are both one level below the package root, so this holds for either.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "components", "registry-index.json");
}

function readIndex(path: string, what: string): RegistryIndex {
  const parsed = parseRegistryIndex(readFileSync(path, "utf8"));
  if (!parsed.index) {
    const first = parsed.errors[0];
    throw new Error(
      `${what} (${path}) is not valid: ${first?.path.join(".") || "(root)"}: ${first?.message ?? "unreadable"}`,
    );
  }
  return parsed.index;
}

/**
 * The indexes whose revocations apply to a project: the one shipped with kampong, and the project's own
 * `.kampong/registry-index.json` if it has one. The project's file can only take trust away: only its
 * revoked entries are read, so unverified text can revoke a component but never vouch for one, and an
 * entry or field it does not understand elsewhere in the file does not stop the revocations. A file that
 * cannot be read is an error, not "no revocations": failing open here would hide a revocation.
 */
export function loadRevocations(projectDir: string): RegistryIndex[] {
  const indexes = [
    readIndex(shippedRegistryIndexPath(), "the registry index shipped with kampong"),
  ];
  const local = join(projectDir, PROJECT_REGISTRY_INDEX);
  if (existsSync(local)) {
    const parsed = parseRevocations(readFileSync(local, "utf8"));
    if (!parsed.revocations) {
      const first = parsed.errors[0];
      throw new Error(
        `this project's registry index (${local}) is not valid: ${first?.path.join(".") || "(root)"}: ${first?.message ?? "unreadable"}`,
      );
    }
    indexes.push(parsed.revocations);
  }
  return indexes;
}

/** Refuses to resolve a component whose exact bytes were revoked. The source is read on every resolve, so a new revocation applies to the next call. */
export class RevocationRegistry implements ComponentRegistry {
  constructor(
    private readonly inner: ComponentRegistry,
    private readonly indexes: () => readonly RegistryIndex[],
  ) {}

  async resolve(id: string, version: string, options?: ResolveOptions): Promise<ResolvedComponent> {
    const resolved = await this.inner.resolve(id, version, options);
    const revocation = findRevocation(this.indexes(), id, version, resolved.digest);
    if (revocation) throw new RevokedComponentError(`${id}@${version}`, revocation);
    return resolved;
  }

  list(): Promise<ComponentSummary[]> {
    return this.inner.list();
  }
}

/**
 * The shipped index for the first-party components on disk: each at tier 0, with every revocation recorded
 * in `previous` carried over (also one whose files are gone or changed, and one that names no digest), so
 * regenerating can never silently un-revoke anything.
 */
export function mergeShippedIndex(
  previous: RegistryIndex | undefined,
  onDisk: { id: string; version: string; digest: string }[],
): RegistryIndex {
  const components: RegistryIndex["components"] = onDisk.map(({ id, version, digest }) => {
    const old = previous?.components.find(
      (c) => c.id === id && c.version === version && c.digest === digest && c.revoked,
    );
    return { id, version, digest, tier: 0, ...(old?.revoked && { revoked: old.revoked }) };
  });
  for (const old of previous?.components ?? []) {
    if (!old.revoked) continue;
    const kept = components.some(
      (c) =>
        c.id === old.id &&
        c.version === old.version &&
        c.digest === old.digest &&
        c.revoked !== undefined,
    );
    if (!kept) components.push(old);
  }
  return { version: 1, components };
}
