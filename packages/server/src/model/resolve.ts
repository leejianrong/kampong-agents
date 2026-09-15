import { and, eq } from "drizzle-orm";
import {
  createMastraModelClient,
  providerRequiresApiKey,
  type CreateMastraModelClientOptions,
  type ModelClient,
} from "@kampong/engine";
import type { AgentSpec } from "@kampong/spec";
import type { DbClient } from "../db/client.js";
import { getByokRootKey } from "../auth/env.js";
import { decryptSecret } from "../crypto/envelope.js";
import { withWorkspaceScope } from "../db/workspace-scope.js";
import { byokKeys } from "../db/schema.js";

// KAN-1230 (ADR-0016/ADR-0013): the hosted, DB-backed successor to
// `createMastraModelClient`'s local `${ENV_VAR}` key resolution. Given a
// workspace and a spec, it resolves a ready-to-run `ModelClient` whose cloud
// provider key is this workspace's own stored BYOK key -- decrypted from
// `byok_keys` (KAN-1229) at the exact moment a run needs to call the provider
// (ADR-0016), never cached, never logged, never in `process.env`.
//
// The decryption deliberately lives here in `packages/server` (where the
// database and the root key are), not in the engine -- the engine must not
// depend on either. It feeds the decrypted key into the engine through the
// intentional `apiKeyOverride` seam (KAN-1230), so the engine stays a pure,
// DB-free model-call builder. This is exactly ADR-0016's "decryption happens
// only inside the model-call resolution path" made concrete across the
// package boundary.
//
// Base URL (ADR-0013): when `LITELLM_BASE_URL` is set, every cloud provider
// call is pointed at the self-hosted LiteLLM gateway's internal address via
// the engine's `baseUrlOverride` seam. The LiteLLM Deployment itself is a
// follow-up (deferred from this card); until it exists, leaving
// `LITELLM_BASE_URL` unset makes the resolved client call the provider
// directly, exactly as local mode does.

export class WorkspaceApiKeyNotConfiguredError extends Error {
  constructor(
    public readonly provider: string,
    public readonly workspaceId: string,
  ) {
    super(`No BYOK key configured for provider "${provider}" in this workspace.`);
    this.name = "WorkspaceApiKeyNotConfiguredError";
  }
}

export interface ResolveWorkspaceModelClientOptions {
  db: DbClient;
  workspaceId: string;
  spec: AgentSpec;
  /** Defaults to `process.env`. The seam ADR-0016 names -- kept injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves a `ModelClient` for `spec` scoped to `workspaceId`, sourcing the
 * cloud provider key from the workspace's stored BYOK key (decrypted at call
 * time). Throws `WorkspaceApiKeyNotConfiguredError` if the spec's provider
 * needs a key and this workspace has none configured. Providers that need no
 * key (e.g. `ollama`) resolve without a lookup. Building the client makes no
 * network call -- that only happens when the run actually generates.
 */
export async function resolveWorkspaceModelClient({
  db,
  workspaceId,
  spec,
  env = process.env,
}: ResolveWorkspaceModelClientOptions): Promise<ModelClient> {
  const modelConfig = spec.agent.model;

  const baseUrlOverride = env["LITELLM_BASE_URL"] || undefined;
  const options: CreateMastraModelClientOptions = baseUrlOverride ? { baseUrlOverride } : {};

  // No model, or a keyless provider (ollama): defer to the engine's own
  // handling (it raises the canonical "no model configured" error, or builds
  // a keyless client) -- nothing to decrypt.
  if (!modelConfig || !providerRequiresApiKey(modelConfig.provider)) {
    return createMastraModelClient(spec, env, options);
  }

  // Cloud provider: fetch this workspace's ciphertext under RLS scope, then
  // decrypt it with the deployment root key.
  const rootKey = getByokRootKey(env);
  const ciphertext = await withWorkspaceScope(db, workspaceId, async (tx) => {
    const [row] = await tx
      .select({ ciphertext: byokKeys.ciphertext })
      .from(byokKeys)
      .where(
        and(eq(byokKeys.workspaceId, workspaceId), eq(byokKeys.provider, modelConfig.provider)),
      );
    return row?.ciphertext;
  });
  if (!ciphertext) {
    throw new WorkspaceApiKeyNotConfiguredError(modelConfig.provider, workspaceId);
  }

  return createMastraModelClient(spec, env, {
    ...options,
    apiKeyOverride: decryptSecret(ciphertext, rootKey),
  });
}
