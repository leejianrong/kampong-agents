import { z } from "zod";
import { componentIdSchema, exactVersionSchema } from "./component.js";

// The registry index (KAN-1838, ADR-0026 and ADR-0037): which component versions exist, at what trust tier,
// and which have been revoked. It is plain JSON so it can be shipped with a release, fetched later, or
// dropped next to a project. A revocation is the only thing a project-local index may add (see the engine's
// `loadRevocations`): an index nobody has verified can take trust away but never grant it.

export const REGISTRY_INDEX_VERSION = 1;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export const revocationSchema = z
  .object({
    /** Why, in words an author can act on. Shown wherever a run, a pin or the canvas refuses it. */
    reason: z.string().min(1).max(500),
    /** When it was revoked, `YYYY-MM-DD`. */
    at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date such as 2026-10-07"),
    /** Where to read more (a security advisory). */
    advisory: z.url().optional(),
  })
  .strict();

export const registryEntrySchema = z
  .object({
    id: componentIdSchema,
    version: exactVersionSchema,
    /** The content digest of the files of this version, as `kampong lock` pins it. */
    digest: z.string().regex(DIGEST, "must be sha256:<64 hex digits>"),
    /** 0 first-party, 1 verified, 2 community (ADR-0026). */
    tier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    revoked: revocationSchema.optional(),
  })
  .strict();

export const registryIndexSchema = z
  .object({
    version: z.literal(REGISTRY_INDEX_VERSION),
    components: z.array(registryEntrySchema),
  })
  .strict()
  .superRefine((index, ctx) => {
    const seen = new Set<string>();
    index.components.forEach((entry, i) => {
      const key = `${entry.id}@${entry.version}:${entry.digest}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `${entry.id}@${entry.version} is listed twice with the same digest`,
          path: ["components", i],
        });
      }
      seen.add(key);
    });
  });

export type RegistryIndex = z.infer<typeof registryIndexSchema>;
export type RegistryEntry = z.infer<typeof registryEntrySchema>;
export type Revocation = z.infer<typeof revocationSchema>;

export type ParsedRegistryIndex =
  | { index: RegistryIndex; errors: [] }
  | { index?: undefined; errors: { path: (string | number)[]; message: string }[] };

/** Parses the index text. Never throws: a malformed file is a list of errors the caller reports. */
export function parseRegistryIndex(text: string): ParsedRegistryIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { errors: [{ path: [], message: `not valid JSON: ${(err as Error).message}` }] };
  }
  const parsed = registryIndexSchema.safeParse(raw);
  if (parsed.success) return { index: parsed.data, errors: [] };
  return {
    errors: parsed.error.issues.map((issue) => ({
      path: issue.path.filter((p): p is string | number => typeof p !== "symbol"),
      message: issue.message,
    })),
  };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Deterministic text, entries sorted, so regenerating the shipped index shows exactly what changed. */
export function serializeRegistryIndex(index: RegistryIndex): string {
  const components = [...index.components]
    .sort((a, b) => cmp(`${a.id}@${a.version}:${a.digest}`, `${b.id}@${b.version}:${b.digest}`))
    .map((entry) => ({
      id: entry.id,
      version: entry.version,
      digest: entry.digest,
      tier: entry.tier,
      ...(entry.revoked && { revoked: entry.revoked }),
    }));
  return `${JSON.stringify({ version: REGISTRY_INDEX_VERSION, components }, null, 2)}\n`;
}

/**
 * The revocation that applies to these exact bytes of `id@version`, if any. A revoked version is matched on
 * its digest, so a component that merely reuses the name with different files is a different thing (the
 * lockfile's digest check already refuses it).
 */
export function findRevocation(
  indexes: readonly RegistryIndex[],
  id: string,
  version: string,
  digest: string,
): Revocation | undefined {
  for (const index of indexes) {
    for (const entry of index.components) {
      if (
        entry.revoked &&
        entry.id === id &&
        entry.version === version &&
        entry.digest === digest
      ) {
        return entry.revoked;
      }
    }
  }
  return undefined;
}
