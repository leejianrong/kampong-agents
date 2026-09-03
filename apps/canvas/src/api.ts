// Talks to the local Fastify server (packages/cli, ADR-0007) that
// `kampong dev` starts. Relative paths so the same code works once the
// server serves this app's built assets from one origin; a base URL can be
// passed for tests/dev-mode where the app and server run on different ports.

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
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
