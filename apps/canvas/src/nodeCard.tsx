import type { ReactNode } from "react";
import type { SpecNode } from "@kampong/spec";
import type { Brand } from "./connectorBrand.js";

// KAM-237 (ADR-0059): every node is a small card: a tinted icon tile, a small-caps kind, the step's name and one
// line saying what it does. The colour is the category and the glyph is the kind; neither is the only signal,
// because the kind is also written. `cardInfo` is pure so the canvas and its tests read a step the same way.

export type Category = "trigger" | "ai" | "tool" | "data" | "flow" | "approval" | "guard";

export type IconName =
  | "clock"
  | "sparkle"
  | "bolt"
  | "wrench"
  | "transform"
  | "shield"
  | "copy"
  | "loop"
  | "branch"
  | "stop"
  | "person"
  | "sliders"
  | "split";

export interface CardInfo {
  category: Category;
  /** What sort of step this is, in words: "Tool step", "Foreach", "Trigger". */
  kind: string;
  name: string;
  /** One line from the step's settings; "" when it has nothing to add. */
  summary: string;
  icon: IconName;
}

/** Long expressions are cut so a card stays small; the whole text is the tooltip. */
const clip = (text: string, n = 56) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

const stepName = (node: SpecNode) => String(node.data.step ?? node.data.name ?? node.id);

function transformSummary(node: SpecNode): string {
  const names = Object.keys((node.data.set as Record<string, string> | undefined) ?? {});
  return names.length === 0 ? "" : clip(`sets ${names.join(", ")}`);
}

function validateSummary(node: SpecNode): string {
  const on = node.data.on_fail === "skip" ? "skip" : "fail";
  return `${clip(`asserts ${String(node.data.assert ?? "")}`)} · on fail ${on}`;
}

function dedupeSummary(node: SpecNode): string {
  const once = (node.data.once ?? {}) as { key?: string; ttl?: string };
  return clip(`once per ${once.key ?? "?"} for ${once.ttl ?? "?"}`);
}

function foreachSummary(node: SpecNode): string {
  const loop = node.data.foreach as {
    items: string;
    as: string;
    concurrency?: number;
    on_error?: string | { retry?: { n: number } };
  };
  const policy =
    typeof loop.on_error === "object" && loop.on_error?.retry
      ? `retry ${loop.on_error.retry.n}`
      : String(loop.on_error ?? "fail");
  return `over ${loop.items} as ${loop.as} · on_error ${policy}${
    loop.concurrency !== undefined ? ` · concurrency ${loop.concurrency}` : ""
  }`;
}

function toolSummary(node: SpecNode): string {
  const d = node.data;
  if (d.action === "http_request")
    return clip(`${String(d.method ?? "GET")} ${String(d.url ?? "")}`);
  if (d.action === "component") {
    const use =
      typeof d.use === "string" ? d.use : String((d.use as { id?: string } | undefined)?.id ?? "");
    return clip(`${use} · ${String(d.op ?? "")}`);
  }
  return typeof d.action === "string" ? d.action.replace(/_/g, " ") : "";
}

/** What a step is and does, for its card. `triggerLabel` is the trigger node's one-line summary (KAM-184). */
export function cardInfo(node: SpecNode): CardInfo {
  const d = node.data;
  if (node.kind === "agent") {
    const label = typeof d.triggerLabel === "string" ? d.triggerLabel : "Manual";
    // "Schedule: every 6h" is a name and a detail; "Webhook (GitHub)" and "Manual" are all name.
    const colon = label.indexOf(": ");
    return {
      category: "trigger",
      kind: "Trigger",
      name: colon === -1 ? label : label.slice(0, colon),
      summary: colon === -1 ? "" : label.slice(colon + 2),
      icon: "clock",
    };
  }
  if (node.kind === "tool") {
    return {
      category: "tool",
      kind: "Tool",
      name: String(d.name ?? node.id),
      summary: toolSummary(node),
      icon: "wrench",
    };
  }
  if (node.kind === "guardrails") {
    return {
      category: "guard",
      kind: "Guardrails",
      name: "Guardrails",
      summary: "",
      icon: "sliders",
    };
  }
  const step = stepName(node);
  if (d.foreach) {
    return {
      category: "flow",
      kind: "Foreach",
      name: step,
      summary: foreachSummary(node),
      icon: "loop",
    };
  }
  if (d.branch) {
    const b = d.branch as { if?: string; switch?: string };
    return {
      category: "flow",
      kind: "Branch",
      name: step,
      summary: b.if !== undefined ? `if ${b.if}` : `switch ${b.switch}`,
      icon: "branch",
    };
  }
  if (d.stop) {
    const stop = d.stop as { reason?: string; status?: string };
    return {
      category: "flow",
      kind: "Stop",
      name: step,
      summary: `ends the run as ${stop.status ?? "skipped"}${stop.reason !== undefined ? `: ${stop.reason}` : ""}`,
      icon: "stop",
    };
  }
  switch (d.type) {
    case "tool":
      return {
        category: "tool",
        kind: "Tool step",
        name: step,
        summary: typeof d.tool === "string" ? `calls ${d.tool}` : "",
        icon: "bolt",
      };
    case "approval":
      return {
        category: "approval",
        kind: "Approval",
        name: step,
        summary: typeof d.message === "string" ? clip(d.message) : "waits for a person",
        icon: "person",
      };
    case "transform":
      return {
        category: "data",
        kind: "Transform",
        name: step,
        summary: transformSummary(node),
        icon: "transform",
      };
    case "validate":
      return {
        category: "data",
        kind: "Validate",
        name: step,
        summary: validateSummary(node),
        icon: "shield",
      };
    case "dedupe":
      return {
        category: "data",
        kind: "Dedupe",
        name: step,
        summary: dedupeSummary(node),
        icon: "copy",
      };
  }
  // A 1.0 condition step has no action of its own; everything else is a step the model carries out.
  if (typeof d.condition === "string") {
    return {
      category: "flow",
      kind: "Condition",
      name: step,
      summary: clip(d.condition),
      icon: "split",
    };
  }
  return {
    category: "ai",
    kind: "AI action",
    name: step,
    summary: typeof d.action === "string" ? clip(d.action) : "",
    icon: "sparkle",
  };
}

const PATHS: Record<IconName, ReactNode> = {
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  wrench: <path d="M14.5 6.5a4 4 0 005 5L20 12 12 20a2.1 2.1 0 01-3-3l8-8zM8 18l-2 2" />,
  transform: <path d="M4 7h10M10 3l4 4-4 4M20 17H10M14 13l-4 4 4 4" />,
  shield: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 012-2h9" />
    </>
  ),
  loop: <path d="M17 2l4 4-4 4M3 11V9a3 3 0 013-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 01-3 3H3" />,
  branch: (
    <>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9c0 6-12 3-12 6" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  person: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11l2 2 4-4" />
    </>
  ),
  sliders: <path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6" />,
  split: <path d="M12 3v7M12 10L6 20M12 10l6 10" />,
};

export function NodeIcon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

/** The card a node draws inside React Flow's own node box (the box keeps the ports, focus and selection). */
export function NodeCard({
  node,
  brand,
  reason,
  isNew,
}: {
  node: SpecNode;
  brand?: Brand | undefined;
  /** Why the step failed in the run on screen (KAM-242): takes the place of the summary, in the error colour. */
  reason?: string | undefined;
  /** The assistant's last Apply added this step (KAM-250). */
  isNew?: boolean | undefined;
}) {
  const info = cardInfo(node);
  const nested =
    node.parent === undefined
      ? ""
      : `in ${node.parent.replace(/^workflow:/, "")}${node.arm !== undefined ? ` · ${node.arm}` : ""}`;
  return (
    <div className={`kg-card kg-card--${info.category}`}>
      {isNew && (
        <span className="kg-card__new" data-testid="card-new">
          New
        </span>
      )}
      <div
        className={`kg-card__tile${brand ? " kg-card__tile--brand" : ""}`}
        {...(brand?.color !== undefined && { style: { background: brand.color, color: "#fff" } })}
      >
        {brand ? (
          <span className="kg-card__letter" data-testid="connector-tile">
            {brand.label}
          </span>
        ) : (
          <NodeIcon name={info.icon} />
        )}
      </div>
      <div className="kg-card__text">
        <div className="kg-card__kind">{info.kind}</div>
        <div className="md3-label-large md3-node__title" title={info.name}>
          {info.name}
        </div>
        {reason !== undefined && (
          <div
            className="kg-card__summary kg-card__reason"
            data-testid="card-reason"
            title={reason}
          >
            {reason}
          </div>
        )}
        {reason === undefined && info.summary !== "" && (
          <div className="kg-card__summary md3-node__meta" title={info.summary}>
            {info.summary}
          </div>
        )}
        {nested !== "" && (
          <div className="kg-card__summary md3-node__meta" title={nested}>
            {nested}
          </div>
        )}
      </div>
    </div>
  );
}
