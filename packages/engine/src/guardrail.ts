// The confidence-threshold guardrail (PLAN.md Shape S3, SLICES.md V2
// KAN-1105). Kept as one small, directly-testable predicate because
// SLICES.md's test plan calls out boundary correctness by name ("at and
// around the boundary value") -- see docs/adr/0009 for where the confidence
// value itself comes from.

export function isBelowConfidenceThreshold(confidence: number, threshold: number): boolean {
  return confidence < threshold;
}
