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

export function createApiClient(baseUrl = "") {
  return {
    async loadSpec(): Promise<LoadSpecResponse> {
      const res = await fetch(`${baseUrl}/api/spec`);
      return (await res.json()) as LoadSpecResponse;
    },

    async applyPatch(ops: PatchOp[]): Promise<ApplyPatchResponse> {
      const res = await fetch(`${baseUrl}/api/spec`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops }),
      });
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
