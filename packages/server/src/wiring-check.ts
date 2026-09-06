import { parseSpec } from "@kampong/spec";
import { createMastraModelClient, type ModelClient } from "@kampong/engine";

// KAN-1221 (V5 build-plan step 1): this package has no real spec storage yet
// (SpecRepository is KAN-1224) and no hosted execution yet (KAN-1227+), so
// there is nothing "real" for this scaffold to run @kampong/spec's validator
// or @kampong/engine's model-client construction against -- both are wired
// in here purely to prove that AGENTS.md's warning ("cross-package imports
// resolve via each package's dist/, which is gitignored -- without a build
// first, those imports fail with TS2307") doesn't silently apply to this new
// package too. This runs once at server startup (createServer, server.ts) --
// not per-request -- so a broken build order fails loudly the moment the
// server tries to start, not weeks from now when packages/server actually
// needs these packages for real spec CRUD (KAN-1227) and hosted execution
// (KAN-1229).
//
// The spec below is a minimal, hard-coded fixture -- never read from disk,
// never user input -- exercising exactly one thing: does `agentSpecSchema`
// (via `parseSpec`) parse successfully through this package's own compiled
// import of @kampong/spec. Using the "ollama" provider for the model-client
// construction means it never touches the network (see engine/src/model.ts's
// `CLOUD_PROVIDERS` set -- only anthropic/openai/openrouter require a BYOK
// key to resolve): constructing the client only exercises
// `createMastraModelClient`'s synchronous validation + Mastra `Agent`
// construction path, matching this repo's own testing approach (AGENTS.md:
// "no live network calls in unit/integration tests").

const WIRING_CHECK_SPEC_SOURCE = `version: "1.0"
agent:
  id: server-wiring-check
  name: "Server wiring check"
  role: "Internal"
  goal: "Prove @kampong/spec and @kampong/engine resolve through packages/server's own dist/ build output."
  model:
    provider: ollama
    name: llama3
  workflow:
    - step: noop
      action: noop
`;

export interface WiringCheckResult {
  specValidator: "ok";
  modelClient: "ok";
}

/**
 * Runs once at server startup (see `createServer` in server.ts). Throws --
 * rather than returning a failure result -- because a failure here means the
 * build/dependency graph is broken, not that a request-time input was bad;
 * the caller is expected to let this crash startup loudly instead of serving
 * traffic from a half-wired process.
 */
export function runStartupWiringCheck(): WiringCheckResult {
  const { success, spec, errors } = parseSpec(WIRING_CHECK_SPEC_SOURCE);
  if (!success || !spec) {
    throw new Error(
      `packages/server startup wiring check failed: @kampong/spec could not parse its ` +
        `own built-in fixture spec: ${JSON.stringify(errors)}`,
    );
  }

  let modelClient: ModelClient;
  try {
    modelClient = createMastraModelClient(spec);
  } catch (err) {
    throw new Error(
      `packages/server startup wiring check failed: @kampong/engine's ` +
        `createMastraModelClient threw while constructing a no-op "ollama" ModelClient: ` +
        `${(err as Error).message}`,
      { cause: err },
    );
  }
  // Constructed only to prove the wiring resolves; deliberately never
  // invoked -- generateText()/generateStructured() would be a real (if
  // pointless) network call, which this startup check must never make.
  void modelClient;

  return { specValidator: "ok", modelClient: "ok" };
}
