// Pure, network-free logic (unit-testable per SLICES.md's V5 test plan):
// a real price move beyond a fixed percent threshold between consecutive
// trading days.

export const DEFAULT_ANOMALY_THRESHOLD_PERCENT = 1.5;

export function resolveAnomalyThreshold(): number {
  const raw = process.env.ANOMALY_THRESHOLD_PERCENT;
  if (!raw) return DEFAULT_ANOMALY_THRESHOLD_PERCENT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`ANOMALY_THRESHOLD_PERCENT must be a positive number, got "${raw}".`);
  }
  return parsed;
}

export function percentChange(previousClose: number, latestClose: number): number {
  if (previousClose === 0) throw new Error("previousClose cannot be 0 (division by zero).");
  return ((latestClose - previousClose) / previousClose) * 100;
}

export function isAnomaly(change: number, threshold = resolveAnomalyThreshold()): boolean {
  return Math.abs(change) >= threshold;
}
