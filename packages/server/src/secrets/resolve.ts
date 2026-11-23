import { and, eq, inArray } from "drizzle-orm";
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
