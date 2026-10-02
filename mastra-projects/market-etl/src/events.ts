import { EventEmitter } from "node:events";

export type EtlEvent =
  | { type: "run_started"; run: string; symbols: string[]; at: number }
  | { type: "symbol_pulled"; run: string; symbol: string; date: string; close: number; at: number }
  | { type: "symbol_validated"; run: string; symbol: string; change: number; at: number }
  | { type: "anomaly_flagged"; run: string; symbol: string; change: number; summary: string; at: number }
  | { type: "symbol_error"; run: string; symbol: string; message: string; at: number }
  | { type: "run_completed"; run: string; anomalyCount: number; at: number };

const RING_SIZE = 100;
const ring: EtlEvent[] = [];
const bus = new EventEmitter();
bus.setMaxListeners(50);

export function emitEtlEvent(event: EtlEvent): void {
  ring.push(event);
  if (ring.length > RING_SIZE) ring.shift();
  bus.emit("event", event);
}

export function recentEtlEvents(): EtlEvent[] {
  return [...ring];
}

export function onEtlEvent(listener: (event: EtlEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
