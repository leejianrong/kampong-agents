// KAM-210: which lines of the spec's YAML belong to which canvas node. Display-only: the YAML is never changed
// (ADR-0054). Node ids are the ones `specToGraph` hands out (`workflow:<step>`, `tool:<name>`, `agent:<id>`,
// `guardrails:<id>`), and steps are found by name the way ADR-0055 addresses them, so a step inside a foreach
// body or a branch arm resolves like a top-level one. Built from the `yaml` package's node ranges (ADR-0007).
import {
  isMap,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Node,
  type Pair,
} from "yaml";

/** 1-based, inclusive line numbers. */
export interface LineRange {
  start: number;
  end: number;
}

export type YamlSourceMap = Map<string, LineRange>;

const IDENTITY_KEYS = ["id", "name", "role", "goal"];

export function buildYamlSourceMap(source: string): YamlSourceMap {
  const map: YamlSourceMap = new Map();
  let doc;
  const lines = new LineCounter();
  try {
    doc = parseDocument(source, { lineCounter: lines });
  } catch {
    return map;
  }
  const root = doc.contents;
  if (!isMap(root)) return map;

  const lineAt = (offset: number) => lines.linePos(offset).line;
  // A node's range runs to the start of the next thing; trim the blank tail so the last line is real text.
  const rangeOf = (from: number, to: number): LineRange => {
    let end = Math.max(from, to);
    while (end > from && /\s/.test(source[end - 1] ?? "")) end--;
    return { start: lineAt(from), end: lineAt(Math.max(from, end - 1)) };
  };
  const nodeRange = (node: Node | null | undefined): [number, number] | undefined =>
    node?.range ? [node.range[0], node.range[1]] : undefined;
  const pairRange = (pair: Pair): LineRange | undefined => {
    const key = nodeRange(pair.key as Node);
    if (!key) return undefined;
    const value = nodeRange(pair.value as Node);
    return rangeOf(key[0], value ? value[1] : key[1]);
  };
  const put = (id: string, range: LineRange | undefined) => {
    if (range && !map.has(id)) map.set(id, range);
  };
  const pairOf = (node: unknown, key: string): Pair | undefined =>
    isMap(node)
      ? (node.items.find((p) => isScalar(p.key) && p.key.value === key) as Pair | undefined)
      : undefined;
  const nameOf = (item: unknown, key: string): string | undefined => {
    const value = pairOf(item, key)?.value;
    return isScalar(value) && typeof value.value === "string" ? value.value : undefined;
  };

  const walk = (list: unknown) => {
    if (!isSeq(list)) return;
    for (const item of list.items) {
      if (!isMap(item)) continue;
      const name = nameOf(item, "step");
      const span = nodeRange(item);
      if (name !== undefined && span) put(`workflow:${name}`, rangeOf(span[0], span[1]));
      const foreach = pairOf(item, "foreach")?.value;
      walk(pairOf(foreach, "steps")?.value);
      const branch = pairOf(item, "branch")?.value;
      walk(pairOf(branch, "then")?.value);
      walk(pairOf(branch, "else")?.value);
      walk(pairOf(branch, "default")?.value);
      const cases = pairOf(branch, "cases")?.value;
      if (isMap(cases)) for (const c of cases.items) if (isPair(c)) walk(c.value);
    }
  };

  const agent = pairOf(root, "agent")?.value;
  if (!isMap(agent)) return map;
  const agentId = nameOf(agent, "id");

  const tools = pairOf(agent, "tools")?.value;
  if (isSeq(tools)) {
    for (const item of tools.items) {
      const name = nameOf(item, "name");
      const span = isMap(item) ? nodeRange(item) : undefined;
      if (name !== undefined && span) put(`tool:${name}`, rangeOf(span[0], span[1]));
    }
  }
  walk(pairOf(agent, "workflow")?.value);

  if (agentId !== undefined) {
    const guardrails = pairOf(agent, "guardrails");
    if (guardrails) put(`guardrails:${agentId}`, pairRange(guardrails));
    // The agent node stands for the trigger and who the agent is: the trigger block when there is one, else the
    // identity lines (id to goal).
    const trigger = pairOf(agent, "trigger");
    if (trigger) put(`agent:${agentId}`, pairRange(trigger));
    else {
      const ranges = IDENTITY_KEYS.map((k) => pairOf(agent, k))
        .map((p) => (p ? pairRange(p) : undefined))
        .filter((r): r is LineRange => r !== undefined);
      if (ranges.length > 0) {
        put(`agent:${agentId}`, {
          start: Math.min(...ranges.map((r) => r.start)),
          end: Math.max(...ranges.map((r) => r.end)),
        });
      }
    }
  }
  return map;
}

/** The node whose lines are the tightest around a line, so a body step wins over the foreach that holds it. */
export function nodeAtLine(map: YamlSourceMap, line: number): string | null {
  let best: { id: string; size: number } | null = null;
  for (const [id, r] of map) {
    if (line < r.start || line > r.end) continue;
    const size = r.end - r.start;
    if (!best || size < best.size) best = { id, size };
  }
  return best?.id ?? null;
}
