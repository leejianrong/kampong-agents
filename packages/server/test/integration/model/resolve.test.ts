import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AgentSpec } from "@kampong/spec";
import { runMigrations } from "../../../src/db/migrate.js";
import { createDbClient, type DbClient } from "../../../src/db/client.js";
import { byokKeys, workspaces } from "../../../src/db/schema.js";
import { withWorkspaceScope } from "../../../src/db/workspace-scope.js";
import { encryptSecret, maskLastFour } from "../../../src/crypto/envelope.js";
import {
  resolveWorkspaceModelClient,
  WorkspaceApiKeyNotConfiguredError,
} from "../../../src/model/resolve.js";

// KAN-1230 (ADR-0016): the hosted per-workspace ModelClient resolution --
// decrypt a workspace's stored BYOK key (KAN-1229) and hand it to the engine
// through the apiKeyOverride seam, at call time. Against a real Postgres so
// the RLS-scoped byok_keys lookup is genuine; no network is ever made
// (building a ModelClient is synchronous local work -- only generate() would
// call a provider, and nothing here does). Skips without DATABASE_URL; runs
// in CI against the non-superuser role (KAN-1388).

const DATABASE_URL = process.env["DATABASE_URL"];
const ROOT_KEY_B64 = randomBytes(32).toString("base64");

function specFor(provider: string, name = "test-model"): AgentSpec {
  // Deliberately NO `api_key` placeholder: hosted mode must not need one --
  // the key comes from byok_keys, not the spec/env. Built as a plain object
  // and cast once (the provider is a string here on purpose).
  return {
    version: "1.0",
    agent: {
      id: "hosted-agent",
      name: "Hosted Agent",
      role: "Tester",
      goal: "Say hello.",
      model: { provider, name },
      workflow: [{ step: "greet", action: "say_hello" }],
    },
  } as unknown as AgentSpec;
}

describe.skipIf(!DATABASE_URL)("resolveWorkspaceModelClient against a real Postgres", () => {
  let db: DbClient;
  let pool: Pool;
  const env = { BYOK_ROOT_KEY: ROOT_KEY_B64 } as NodeJS.ProcessEnv;
  const createdWorkspaceIds: string[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await runMigrations(DATABASE_URL);
    ({ db, pool } = createDbClient(DATABASE_URL));
  });

  afterAll(async () => {
    if (!DATABASE_URL) return;
    for (const id of createdWorkspaceIds) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    await pool?.end();
  });

  async function createWorkspace(): Promise<string> {
    const [row] = await db
      .insert(workspaces)
      .values({ name: "resolve-test", slug: randomUUID() })
      .returning({ id: workspaces.id });
    createdWorkspaceIds.push(row!.id);
    return row!.id;
  }

  async function storeKey(workspaceId: string, provider: string, rawKey: string): Promise<void> {
    const ciphertext = encryptSecret(rawKey, Buffer.from(ROOT_KEY_B64, "base64"));
    await withWorkspaceScope(db, workspaceId, (tx) =>
      tx
        .insert(byokKeys)
        .values({ workspaceId, provider, ciphertext, lastFour: maskLastFour(rawKey) }),
    );
  }

  it("resolves a ModelClient using the workspace's decrypted key, with no spec placeholder or env key", async () => {
    const workspaceId = await createWorkspace();
    await storeKey(workspaceId, "openai", "sk-openai-workspace-key-0001");

    const client = await resolveWorkspaceModelClient({
      db,
      workspaceId,
      spec: specFor("openai", "gpt-4o-mini"),
      env,
    });
    expect(typeof client.generateText).toBe("function");
    expect(typeof client.generateStructured).toBe("function");
  });

  it("throws WorkspaceApiKeyNotConfiguredError when the workspace has no key for the provider", async () => {
    const workspaceId = await createWorkspace();
    await expect(
      resolveWorkspaceModelClient({ db, workspaceId, spec: specFor("openai"), env }),
    ).rejects.toBeInstanceOf(WorkspaceApiKeyNotConfiguredError);
  });

  it("does not resolve another workspace's key: RLS hides it, so it reports not-configured", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    await storeKey(a, "openai", "sk-a-only-9999");

    // B has no openai key of its own; A's is invisible under B's scope.
    await expect(
      resolveWorkspaceModelClient({ db, workspaceId: b, spec: specFor("openai"), env }),
    ).rejects.toBeInstanceOf(WorkspaceApiKeyNotConfiguredError);
  });

  it("reports not-configured when a key exists for a DIFFERENT provider than the spec asks for", async () => {
    const workspaceId = await createWorkspace();
    await storeKey(workspaceId, "openai", "sk-openai-key");
    await expect(
      resolveWorkspaceModelClient({ db, workspaceId, spec: specFor("anthropic"), env }),
    ).rejects.toBeInstanceOf(WorkspaceApiKeyNotConfiguredError);
  });

  it("resolves a keyless provider (ollama) with no stored key and no decryption", async () => {
    const workspaceId = await createWorkspace();
    const client = await resolveWorkspaceModelClient({
      db,
      workspaceId,
      spec: specFor("ollama", "llama3.2"),
      env,
    });
    expect(typeof client.generateText).toBe("function");
  });

  it("routes through the LiteLLM gateway address when LITELLM_BASE_URL is set", async () => {
    const workspaceId = await createWorkspace();
    await storeKey(workspaceId, "openai", "sk-openai-gateway-key");
    const client = await resolveWorkspaceModelClient({
      db,
      workspaceId,
      spec: specFor("openai"),
      env: { ...env, LITELLM_BASE_URL: "http://litellm.internal:4000" },
    });
    // The base-URL override is wired through the engine's baseUrlOverride seam
    // (covered directly in the engine's own tests); here we prove the hosted
    // resolver still produces a usable client with it set.
    expect(typeof client.generateText).toBe("function");
  });
});
