import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createComponentDispatcher,
  createFirstPartyRegistry,
  DirectoryComponentRegistry,
  InProcessModuleRunner,
  LayeredComponentRegistry,
  loadRevocations,
  RevocationRegistry,
  isFirstPartyId,
  type ComponentDispatcher,
  type ComponentRegistry,
} from "@kampong/engine";
import type { ExportComponent } from "@kampong/exporter";
import {
  LOCKFILE_NAME,
  parseLockfile,
  serializeLockfile,
  catalogEntryFromManifest,
  describePermissions,
  findRevocation,
  diffPermissions,
  permissionsOf,
  type AgentSpec,
  type ComponentCatalog,
  type ComponentCatalogEntry,
  type ComponentManifest,
  type ComponentPinStatus,
  type Lockfile,
} from "@kampong/spec";

// Where a spec's components live and how they are pinned (KAN-1884, KAN-1834): a `components/` folder
// and a `kampong.lock` next to the spec file. Components are laid out as
// `components/<namespace>/<name>/<version>/component.yaml`.

export function componentsDirFor(specPath: string): string {
  return join(dirname(specPath), "components");
}

export function lockPathFor(specPath: string): string {
  return join(dirname(specPath), LOCKFILE_NAME);
}

/** The lockfile beside the spec, or an empty one when there is none. A malformed file throws. */
export function readLockfile(specPath: string): Lockfile {
  const path = lockPathFor(specPath);
  if (!existsSync(path)) return { version: 1, components: {} };
  const parsed = parseLockfile(readFileSync(path, "utf8"));
  if (!parsed.lockfile) {
    const first = parsed.errors[0];
    throw new Error(
      `${LOCKFILE_NAME} is not valid: ${first?.path.join(".") || "(root)"}: ${first?.message ?? "unreadable"}${first?.line ? ` (line ${first.line})` : ""}. Fix it or delete it and run \`kampong lock\`.`,
    );
  }
  return parsed.lockfile;
}

/** The project's components plus the first-party ones that ship with kampong. */
export function registryFor(specPath: string): ComponentRegistry {
  // Revoked components are refused wherever they would resolve: a run, a pin, an export and the doctor
  // (KAN-1838). The revocations are read on each resolve, so one added to .kampong/registry-index.json
  // applies without a restart, and one that cannot be read stops the call rather than being ignored.
  return new RevocationRegistry(
    new LayeredComponentRegistry(
      new DirectoryComponentRegistry(componentsDirFor(specPath)),
      createFirstPartyRegistry(),
    ),
    () => loadRevocations(dirname(specPath)),
  );
}

function pinsFor(specPath: string): () => Record<string, string> {
  // Read on each call so a lockfile edited while `kampong dev` is running applies without a restart.
  return () =>
    Object.fromEntries(
      Object.entries(readLockfile(specPath).components).map(([key, entry]) => [key, entry.digest]),
    );
}

export function componentDispatcherFor(specPath: string): ComponentDispatcher {
  const registry = registryFor(specPath);
  const pins = pinsFor(specPath);
  return createComponentDispatcher({
    registry,
    runner: new InProcessModuleRunner(registry, pins, { requirePins: true }),
    pins,
    requirePins: true,
  });
}

export type LockOutcome =
  | {
      ok: true;
      added: string[];
      unchanged: string[];
      updated: string[];
      none: boolean;
      /** What each newly pinned or updated component may do, for the author to read. */
      reviewed: { use: string; summary: string }[];
    }
  | {
      ok: false;
      message: string;
      /** The files are not the ones the caller reviewed. */ stale?: boolean;
    };

/**
 * What a component may do now that the pin it was reviewed under did not allow. A pin that recorded
 * what the component could do lets us tell a code change from a wider grant; with no record there is
 * nothing to compare, so anything it may do counts as new. The lock and the canvas both use this, so
 * they cannot disagree about whether consent is needed.
 */
function widenedSince(
  before: ReturnType<typeof permissionsOf> | undefined,
  now: ReturnType<typeof permissionsOf>,
): string[] {
  if (before !== undefined) return diffPermissions(before, now);
  const summary = describePermissions(now);
  return summary === "no permissions"
    ? []
    : [`no record of what it was reviewed for; it may now: ${summary}`];
}

export function componentUsesOf(spec: AgentSpec): string[] {
  const uses = new Set<string>();
  for (const tool of spec.agent.tools ?? []) {
    if (tool.action === "component") uses.add(tool.use);
  }
  return [...uses].sort();
}

/**
 * Pins every component the spec uses. New components are added; one whose digest differs from its pin
 * is refused unless `update` is set, because that is exactly the event a reviewer must see. Nothing is
 * written unless every component resolves and no refusal occurred.
 */
export async function lockComponents(
  spec: AgentSpec,
  specPath: string,
  options: { update: boolean; allowWiderPermissions?: boolean },
): Promise<LockOutcome> {
  return lockUses(componentUsesOf(spec), specPath, options);
}

/** `lockComponents` for an explicit list of `id@version`, which is how the canvas pins one component. */
export async function lockUses(
  uses: string[],
  specPath: string,
  {
    update,
    allowWiderPermissions = false,
    expectedDigest,
  }: { update: boolean; allowWiderPermissions?: boolean; expectedDigest?: string },
): Promise<LockOutcome> {
  if (uses.length === 0) {
    return { ok: true, added: [], unchanged: [], updated: [], none: true, reviewed: [] };
  }
  let lock: Lockfile;
  try {
    lock = readLockfile(specPath);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  const registry = registryFor(specPath);
  const components = { ...lock.components };
  const added: string[] = [];
  const unchanged: string[] = [];
  const updated: string[] = [];
  const refused: string[] = [];
  const widened: string[] = [];
  const backfilled: string[] = [];
  const reviewed: { use: string; summary: string }[] = [];
  for (const use of uses) {
    const at = use.lastIndexOf("@");
    if (at <= 0) {
      return { ok: false, message: `${use}: expected "id@version" (for example acme/echo@1.0.0)` };
    }
    let digest: string;
    let permissions: ReturnType<typeof permissionsOf>;
    try {
      const resolved = await registry.resolve(use.slice(0, at), use.slice(at + 1));
      digest = resolved.digest;
      permissions = permissionsOf(resolved.manifest);
    } catch (err) {
      return { ok: false, message: `${use}: ${(err as Error).message}` };
    }
    // A caller that showed an author a digest (the canvas) must pin that one: files edited in between
    // would otherwise be pinned unreviewed.
    if (expectedDigest !== undefined && uses.length === 1 && digest !== expectedDigest) {
      return {
        ok: false,
        stale: true,
        message: `${use} changed since you reviewed it; review it again before pinning.`,
      };
    }
    const current = Object.hasOwn(components, use) ? components[use]!.digest : undefined;
    if (current === undefined) {
      components[use] = { digest, permissions };
      added.push(use);
      reviewed.push({ use, summary: describePermissions(permissions) });
    } else if (current === digest) {
      unchanged.push(use);
      // The files are the ones that were pinned, so what they may do is what a record would say: write it
      // down, so a later update has something to be compared with.
      if (components[use]!.permissions === undefined) {
        components[use] = { digest, permissions };
        backfilled.push(use);
      }
    } else if (update) {
      const wider = widenedSince(components[use]!.permissions, permissions);
      if (wider.length > 0 && !allowWiderPermissions) {
        widened.push(`${use}: ${wider.join("; ")}`);
        continue;
      }
      components[use] = { digest, permissions };
      updated.push(use);
      reviewed.push({ use, summary: describePermissions(permissions) });
    } else {
      refused.push(use);
    }
  }
  if (refused.length > 0) {
    return {
      ok: false,
      message: `${refused.join(", ")} changed since it was pinned in ${LOCKFILE_NAME}. Review the change, then run \`kampong lock --update\` to accept it.`,
    };
  }
  if (widened.length > 0) {
    return {
      ok: false,
      message: `the update widens what a component may do:\n  ${widened.join("\n  ")}\nReview it, then add --allow-wider-permissions to accept it.`,
    };
  }
  if (added.length > 0 || updated.length > 0 || backfilled.length > 0) {
    // Resolving above took time; another `kampong lock` may have written meanwhile. Re-read the file
    // now (no awaits between here and the rename) and apply only this run's changes to it, so
    // concurrent runs cannot drop each other's pins.
    let latest: Lockfile;
    try {
      latest = readLockfile(specPath);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    const merged = { ...latest.components };
    for (const use of [...added, ...updated, ...backfilled]) merged[use] = components[use]!;
    // Written to a temporary file and renamed, so a crash cannot leave a truncated lockfile.
    const target = lockPathFor(specPath);
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, serializeLockfile({ version: 1, components: merged }));
    renameSync(temp, target);
  }
  return { ok: true, added, unchanged, updated, none: false, reviewed };
}

/** What the canvas needs to build forms for the components installed beside a spec. */
export async function componentCatalogFor(specPath: string): Promise<ComponentCatalog> {
  try {
    return await buildCatalog(specPath);
  } catch (err) {
    // The canvas expects a catalog; an unreadable folder is reported as a problem, not a 500.
    return { components: [], problems: [`could not read components: ${(err as Error).message}`] };
  }
}

function pinStatusFor(
  entry: ComponentCatalogEntry,
  firstParty: boolean,
  lock: Lockfile | undefined,
  manifestPermissions: ReturnType<typeof permissionsOf>,
): ComponentPinStatus | undefined {
  if (firstParty) return { state: "first-party" };
  if (!lock) return undefined;
  const ref = `${entry.id}@${entry.version}`;
  if (!Object.hasOwn(lock.components, ref)) return { state: "unpinned" };
  const pinned = lock.components[ref]!;
  if (pinned.digest === entry.digest) return { state: "pinned" };
  const widened = widenedSince(pinned.permissions, manifestPermissions);
  return { state: "changed", ...(widened.length > 0 && { widened }) };
}

async function buildCatalog(specPath: string): Promise<ComponentCatalog> {
  // One scan and one hash per component. The first-party components ship tested, so only the project's
  // own folder can report problems; it also cannot supply a kampong/* component (the registry refuses).
  const [firstParty, user] = await Promise.all([
    createFirstPartyRegistry().resolveAll(),
    new DirectoryComponentRegistry(componentsDirFor(specPath)).resolveAll(),
  ]);
  // A lockfile that cannot be read is a problem to show, not a reason to hide the components.
  const problems = [...firstParty.problems, ...user.problems];
  let lock: Lockfile | undefined;
  try {
    lock = readLockfile(specPath);
  } catch (err) {
    problems.push((err as Error).message);
  }
  let revocations: ReturnType<typeof loadRevocations> = [];
  try {
    revocations = loadRevocations(dirname(specPath));
  } catch (err) {
    problems.push((err as Error).message);
  }
  const entry =
    (firstPartyEntry: boolean) => (c: { manifest: ComponentManifest; digest: string }) => {
      const base = catalogEntryFromManifest(c.manifest, c.digest);
      const pin = pinStatusFor(base, firstPartyEntry, lock, permissionsOf(c.manifest));
      const revoked = findRevocation(revocations, c.manifest.id, c.manifest.version, c.digest);
      return { ...base, ...(pin && { pin }), ...(revoked && { revoked }) };
    };
  return {
    components: [...firstParty.components.map(entry(true)), ...user.components.map(entry(false))],
    problems,
  };
}

/**
 * Resolves the components an export must carry: each is read from the project's folder or the
 * first-party set, checked against its lockfile pin the way a run would, and handed over with its files.
 * Exporting unpinned or changed code would ship what no run has been allowed to execute.
 */
export async function resolveExportComponents(
  specPath: string,
  refs: string[],
  explicit: string[] = refs,
): Promise<ExportComponent[]> {
  const registry = registryFor(specPath);
  // A component that is only there because a legacy Slack or Gmail tool desugars onto it never
  // consults the lockfile, as in a run: a malformed or stale lockfile must not stop that export.
  const named = new Set(explicit);
  const lock = refs.some((ref) => named.has(ref)) ? readLockfile(specPath) : undefined;
  const out: ExportComponent[] = [];
  for (const ref of refs) {
    const at = ref.lastIndexOf("@");
    const id = ref.slice(0, at);
    const pinned =
      lock && named.has(ref) && Object.hasOwn(lock.components, ref)
        ? lock.components[ref]!.digest
        : undefined;
    if (pinned === undefined && named.has(ref) && !isFirstPartyId(id)) {
      throw new Error(
        `component ${ref} is not pinned in ${LOCKFILE_NAME}; review it and run \`kampong lock\` before exporting`,
      );
    }
    const resolved = await registry.resolve(id, ref.slice(at + 1), { expectedDigest: pinned });
    out.push({
      manifest: resolved.manifest,
      digest: resolved.digest,
      files: Object.fromEntries(resolved.files ?? []),
    });
  }
  return out;
}
