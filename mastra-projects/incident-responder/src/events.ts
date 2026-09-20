import { EventEmitter } from "node:events";

export type IncidentEvent =
  | { type: "alert_firing"; incident: string; alertname: string; severity: string; at: number }
  | { type: "alert_resolved"; incident: string; alertname: string; at: number }
  | { type: "diagnosis_started"; incident: string; at: number }
  | { type: "diagnosis_ready"; incident: string; summary: string; likelyCause: string; at: number }
  | { type: "proposal_posted"; incident: string; proposedFix: string; at: number }
  | { type: "human_decision"; incident: string; decision: "approved" | "rejected"; by?: string; at: number }
  | { type: "incident_error"; incident: string; message: string; at: number };

const RING_SIZE = 100;
const ring: IncidentEvent[] = [];
const bus = new EventEmitter();
bus.setMaxListeners(50);

export function emitIncidentEvent(event: IncidentEvent): void {
  ring.push(event);
  if (ring.length > RING_SIZE) ring.shift();
  bus.emit("event", event);
}

export function recentIncidentEvents(): IncidentEvent[] {
  return [...ring];
}

export function onIncidentEvent(listener: (event: IncidentEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
