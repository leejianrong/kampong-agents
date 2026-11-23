import type { RunOptionsVarDto } from "./api.js";

// KAM-306: what a run was run with, in a few words, so two runs of the same workflow with different vars or input
// can be told apart in the Runs list: "symbols: 25 items, threshold: 3" or "input: hello". Only what differs from
// the spec's defaults is said; a run with nothing changed says "default values" when the workflow has vars.

const short = (text: string, max = 24) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One changed var as a few words: a list as its length, anything else as its (short) value. */
export function describeVarValue(decl: RunOptionsVarDto, text: string): string {
  if (decl.type === "list") {
    const n = text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean).length;
    return `${n} ${n === 1 ? "item" : "items"}`;
  }
  return short(text.trim());
}

export function describeRunWith(
  input: string,
  declared: readonly RunOptionsVarDto[],
  changed: Readonly<Record<string, string>>,
): string {
  const parts = declared
    .filter((v) => Object.hasOwn(changed, v.name))
    .map((v) => `${v.name}: ${describeVarValue(v, changed[v.name] ?? "")}`);
  const said = input.trim();
  if (said !== "") parts.push(`input: ${short(said.replace(/\s+/g, " "), 30)}`);
  if (parts.length === 0) return declared.length > 0 ? "default values" : "";
  return parts.join(", ");
}
