export interface ToyServiceDebug {
  mode: string;
  changedAt: number;
  recentRequests: { at: number; latencyMs: number; error: boolean }[];
}

/** The diagnostician's one real tool call: ask the actual monitored service what state it's in, rather than guessing from the alert alone. */
export async function fetchToyServiceDebug(): Promise<ToyServiceDebug> {
  const baseUrl = process.env.TOY_SERVICE_URL ?? "http://localhost:9100";
  const response = await fetch(`${baseUrl}/debug`);
  if (!response.ok) {
    throw new Error(`toy-service /debug returned HTTP ${response.status}`);
  }
  return (await response.json()) as ToyServiceDebug;
}
