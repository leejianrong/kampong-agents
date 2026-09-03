// Vendored, unmodified, from packages/engine/src/guardrail.ts as part of a
// `kampong export` -- see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md.
// From here on this file is yours: no dependency on the tool that generated
// it (ADR-0002), and it will not be touched again by a future export.

export function isBelowConfidenceThreshold(confidence: number, threshold: number): boolean {
  return confidence < threshold;
}
