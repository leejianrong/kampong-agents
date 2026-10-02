import { EventEmitter } from "node:events";
import type { MatchedChunk } from "./supabase-client.js";

export type ResearchEvent =
  | { type: "query_received"; query: string; question: string; at: number }
  | { type: "chunks_retrieved"; query: string; chunks: MatchedChunk[]; at: number }
  | { type: "answer_ready"; query: string; answer: string; citedPaths: string[]; at: number }
  | { type: "query_error"; query: string; message: string; at: number };

const RING_SIZE = 50;
const ring: ResearchEvent[] = [];
const bus = new EventEmitter();
bus.setMaxListeners(50);

export function emitResearchEvent(event: ResearchEvent): void {
  ring.push(event);
  if (ring.length > RING_SIZE) ring.shift();
  bus.emit("event", event);
}

export function recentResearchEvents(): ResearchEvent[] {
  return [...ring];
}

export function onResearchEvent(listener: (event: ResearchEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
