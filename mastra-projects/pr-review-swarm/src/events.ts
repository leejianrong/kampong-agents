import { EventEmitter } from "node:events";

export type SwarmEvent =
  | { type: "webhook_received"; pr: string; at: number }
  | { type: "planner_routed"; pr: string; specialists: string[]; at: number }
  | { type: "specialist_verdict"; pr: string; specialist: string; findings: number; at: number }
  | { type: "comment_posted"; pr: string; at: number }
  | { type: "review_error"; pr: string; message: string; at: number };

const RING_SIZE = 100;
const ring: SwarmEvent[] = [];
const bus = new EventEmitter();
bus.setMaxListeners(50);

export function emitSwarmEvent(event: SwarmEvent): void {
  ring.push(event);
  if (ring.length > RING_SIZE) ring.shift();
  bus.emit("event", event);
}

export function recentSwarmEvents(): SwarmEvent[] {
  return [...ring];
}

export function onSwarmEvent(listener: (event: SwarmEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
