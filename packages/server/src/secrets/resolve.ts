import { and, eq, inArray } from "drizzle-orm";
import { createFirstPartyRegistry } from "@kampong/engine";
import type { DbClient } from "../db/client.js";
import { getByokRootKey } from "../auth/env.js";
import { decryptSecret } from "../crypto/envelope.js";
import { withWorkspaceScope } from "../db/workspace-scope.js";
import { workspaceSecrets } from "../db/schema.js";

// KAM-81 (ADR-0016, ADR-0022): the hosted counterpart of a local `.env` for connector credentials. A hosted run's
// tools read `${NAME}` placeholders from an environment; locally that is process.env, hosted it is EMPTY (a tenant's
// spec must not name the server's own secrets). This resolves the names a spec actually references from the
// workspace's own vault, decrypted at the moment a run starts, held only in that run's environment, never cached,
// never logged, never sent to the client. Only referenced names are decrypted, so a run holds no more of the
// workspace's secrets than its spec names.
//
// A name the workspace has not stored is simply absent: the engine then fails the step that needs it, visibly, naming
// the variable ("Not set yet: SLACK_BOT_TOKEN"), the same as locally. It is not an error here because a `${NAME}` may
// also be a var default or an optional field.

/** A secret's name is an environment-variable name: what a spec writes between `${` and `}`. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

const ENV_REF = /(?<!\$)\$\{([A-Z][A-Z0-9_]*)\}/g;

/** Every `${NAME}` an arbitrary value reads, `$${NAME}` (an escape) excluded. */
export function envNamesIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(ENV_REF)) if (match[1] !== undefined) into.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) envNamesIn(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) envNamesIn(item, into);
  }
  return into;
}

const firstParty = createFirstPartyRegistry();

/**
 * Every environment name a spec's run may read: its `${NAME}` placeholders, plus the credential slots of the
 * first-party components its tools use (a component reads its credential through a slot that never appears as
 * `${NAME}` in the spec), after the tool's own `secrets` remaps. A component that cannot be resolved adds nothing
 * here; the run itself reports it.
 */
export async function secretNamesFor(spec: unknown): Promise<Set<string>> {
  const names = envNamesIn(spec);
  const tools = (spec as { agent?: { tools?: unknown } } | undefined)?.agent?.tools;
  if (!Array.isArray(tools)) return names;
  for (const tool of tools as {
    action?: string;
    use?: string;
    secrets?: Record<string, string>;
  }[]) {
    if (tool.action !== "component" || typeof tool.use !== "string") continue;
    const at = tool.use.lastIndexOf("@");
    if (at <= 0) continue;
    try {
      const { manifest } = await firstParty.resolve(tool.use.slice(0, at), tool.use.slice(at + 1));
      for (const [slot, def] of Object.entries(manifest.auth?.slots ?? {})) {
        const remap =
          tool.secrets && Object.hasOwn(tool.secrets, slot) ? tool.secrets[slot] : undefined;
        names.add(remap === undefined ? def.env : (/^\$\{(.+)\}$/.exec(remap)?.[1] ?? remap));
      }
    } catch {
      // not a first-party component, or a bad id/version: the run reports it
    }
  }
  return names;
}

export interface ResolveWorkspaceSecretsOptions {
  db: DbClient;
  workspaceId: string;
  /** The env-var names to look up (see `envNamesIn`). */
  names: Iterable<string>;
  /** Defaults to `process.env`; read only for the BYOK root key. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The decrypted workspace secrets for `names`, as an environment object for a run. Names the workspace has not
 * stored are left out. Returns `{}` without touching the database or the root key when there is nothing to look up.
 */
export async function resolveWorkspaceSecrets({
  db,
  workspaceId,
  names,
  env = process.env,
}: ResolveWorkspaceSecretsOptions): Promise<Record<string, string>> {
  const wanted = [...new Set(names)].filter((n) => SECRET_NAME_RE.test(n));
  if (wanted.length === 0) return {};

  const rows = await withWorkspaceScope(db, workspaceId, (tx) =>
    tx
      .select({ name: workspaceSecrets.name, ciphertext: workspaceSecrets.ciphertext })
      .from(workspaceSecrets)
      .where(
        and(eq(workspaceSecrets.workspaceId, workspaceId), inArray(workspaceSecrets.name, wanted)),
      ),
  );
  if (rows.length === 0) return {};

  const rootKey = getByokRootKey(env);
  const out: Record<string, string> = {};
  for (const row of rows) out[row.name] = decryptSecret(row.ciphertext, rootKey);
  return out;
}
