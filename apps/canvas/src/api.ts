// Talks to the local Fastify server (packages/cli, ADR-0007) that
// `kampong dev` starts. Relative paths so the same code works once the
// server serves this app's built assets from one origin; a base URL can be
// passed for tests/dev-mode where the app and server run on different ports.
//
// Run-related types are `import type`-only from @kampong/engine (SLICES.md
// V2 KAN-1107): the canvas never bundles @mastra/core or any engine runtime
// code -- it only calls the server's HTTP API -- so a type-only import,
// erased at build time, is the safe way to share these shapes without
// pulling a Node-only package into the browser bundle.
import type { PendingApproval, RunEvent, RunState } from "@kampong/engine";

export interface SpecErrorDto {
  path: (string | number)[];
  message: string;
  line?: number;
  column?: number;
}

export interface LoadSpecResponse {
  success: boolean;
  spec?: Record<string, unknown>;
  errors: SpecErrorDto[];
  layout: Record<string, { x: number; y: number }>;
  source: string;
}

export type PatchOp =
  | { op: "set"; path: (string | number)[]; value: unknown }
  | { op: "add"; path: (string | number)[]; value: unknown }
  | { op: "remove"; path: (string | number)[] };

export interface ApplyPatchResponse {
  success: boolean;
  spec?: Record<string, unknown>;
  errors?: SpecErrorDto[];
}

export interface StartRunResponse {
  success: boolean;
  id?: string;
  state?: RunState;
  errors?: SpecErrorDto[];
  error?: string;
}

export interface ApproveRunResponse {
  success: boolean;
  state?: RunState;
  error?: string;
}

export type RunEventMessage =
  { type: "state"; state: RunState } | { type: "event"; event: RunEvent; state: RunState };

export type { PendingApproval, RunEvent, RunState };

// KAN-1216: a non-2xx /api/spec response (e.g. the 404 the server now
// returns for a spec file deleted out from under a running `kampong dev`,
// SLICES.md V1/ADR-0008) used to get parsed and cast to the success-shaped
// DTO anyway -- `success` came back `undefined` (not `false`), so callers
// that only checked `.success`/`.errors` treated it as "nothing to report"
// and silently no-op'd instead of surfacing anything. `loadSpec`/
// `applyPatch` now check `res.ok` first and throw this instead, so App.tsx
// can catch it and show a real error banner.
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function errorMessageFor(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; errors?: { message: string }[] };
    if (typeof body.error === "string" && body.error.length > 0) return body.error;
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      return body.errors.map((e) => e.message).join("; ");
    }
  } catch {
    // Body wasn't JSON (or was empty) -- fall through to the generic message.
  }
  return fallback;
}

export function createApiClient(baseUrl = "") {
  return {
    async loadSpec(): Promise<LoadSpecResponse> {
      const res = await fetch(`${baseUrl}/api/spec`);
      if (!res.ok) {
        throw new ApiError(
          await errorMessageFor(res, `Failed to load the spec (HTTP ${res.status}).`),
          res.status,
        );
      }
      return (await res.json()) as LoadSpecResponse;
    },

    async applyPatch(ops: PatchOp[]): Promise<ApplyPatchResponse> {
      const res = await fetch(`${baseUrl}/api/spec`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops }),
      });
      if (!res.ok) {
        throw new ApiError(
          await errorMessageFor(res, `Failed to save the change (HTTP ${res.status}).`),
          res.status,
        );
      }
      return (await res.json()) as ApplyPatchResponse;
    },

    subscribeToEvents(onEvent: (event: { type: string; source: string }) => void): () => void {
      const source = new EventSource(`${baseUrl}/api/events`);
      source.onmessage = (message) => {
        onEvent(JSON.parse(message.data));
      };
      return () => source.close();
    },

    async startRun(input: string): Promise<StartRunResponse> {
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
      return (await res.json()) as StartRunResponse;
    },

    async approveRun(id: string, approved: boolean, reason?: string): Promise<ApproveRunResponse> {
      const res = await fetch(`${baseUrl}/api/runs/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved, reason }),
      });
      return (await res.json()) as ApproveRunResponse;
    },

    subscribeToRunEvents(id: string, onMessage: (message: RunEventMessage) => void): () => void {
      const source = new EventSource(`${baseUrl}/api/runs/${id}/events`);
      source.onmessage = (message) => {
        onMessage(JSON.parse(message.data));
      };
      return () => source.close();
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
