import { EventEmitter } from "node:events";

export type TriageEvent =
  | { type: "ticket_received"; ticket: string; from: string; subject: string; at: number }
  | { type: "classification_started"; ticket: string; at: number }
  | {
      type: "classification_ready";
      ticket: string;
      category: string;
      confidence: number;
      at: number;
    }
  | { type: "draft_created"; ticket: string; draftId: string; at: number }
  | { type: "escalation_posted"; ticket: string; reason: string; at: number }
  | { type: "human_decision"; ticket: string; decision: "approved" | "rejected"; by?: string; at: number }
  | { type: "ticket_error"; ticket: string; message: string; at: number };

const RING_SIZE = 100;
const ring: TriageEvent[] = [];
const bus = new EventEmitter();
bus.setMaxListeners(50);

export function emitTriageEvent(event: TriageEvent): void {
  ring.push(event);
  if (ring.length > RING_SIZE) ring.shift();
  bus.emit("event", event);
}

export function recentTriageEvents(): TriageEvent[] {
  return [...ring];
}

export function onTriageEvent(listener: (event: TriageEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
