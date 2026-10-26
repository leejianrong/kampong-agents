import type { ComponentBrand, SpecGraph } from "@kampong/spec";

// KAM-247 (ADR-0059 §7): a connector is recognised by a letter on a colour, not a glyph. A component's manifest may
// carry its own `brand`; the built-in Slack and Gmail tools have one here; any other component gets the first letter
// of its name on the tool colour, so a connector never looks like a generic wrench.

/** What a tile shows. Without a `color` the tile keeps its category colours. */
export interface Brand {
  label: string;
  color?: string;
}

const BUILT_IN: Record<string, Brand> = {
  slack_post_message: { label: "S", color: "#4A154B" },
  gmail_send: { label: "G", color: "#B3261E" },
};

/** `kampong/slack@1.0.0` -> "S": the first letter of the name, upper-cased. */
function initialOf(use: string): string {
  const name = use.slice(use.indexOf("/") + 1);
  return (name[0] ?? "?").toUpperCase();
}

/** The component brands a catalog knows, by `id@version`, as a spec's `use` writes them. */
export function brandsFromCatalog(
  components: { id: string; version: string; brand?: ComponentBrand }[],
): Record<string, ComponentBrand> {
  const out: Record<string, ComponentBrand> = {};
  for (const c of components) if (c.brand !== undefined) out[`${c.id}@${c.version}`] = c.brand;
  return out;
}

/** The brand of a tool's own data, or undefined for a plain http_request. */
function toolBrand(
  tool: Record<string, unknown>,
  known: Record<string, ComponentBrand>,
): Brand | undefined {
  if (tool.action === "component" && typeof tool.use === "string") {
    return known[tool.use] ?? { label: initialOf(tool.use) };
  }
  return typeof tool.action === "string" ? BUILT_IN[tool.action] : undefined;
}

/**
 * The brand to draw on each node that has one, by node id: a tool node, and a tool step (which shows its tool's
 * tile, so a step that posts to Slack reads as Slack).
 */
export function connectorBrands(
  graph: SpecGraph,
  known: Record<string, ComponentBrand> = {},
): Record<string, Brand> {
  const byTool = new Map<string, Record<string, unknown>>();
  for (const n of graph.nodes) if (n.kind === "tool") byTool.set(String(n.data.name), n.data);
  const out: Record<string, Brand> = {};
  for (const n of graph.nodes) {
    const tool =
      n.kind === "tool"
        ? n.data
        : n.kind === "workflow" && typeof n.data.tool === "string"
          ? byTool.get(n.data.tool)
          : undefined;
    const brand = tool && toolBrand(tool, known);
    if (brand) out[n.id] = brand;
  }
  return out;
}
