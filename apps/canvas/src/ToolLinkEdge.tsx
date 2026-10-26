import { BaseEdge, useInternalNode, type EdgeProps } from "@xyflow/react";

// KAM-241 (ADR-0059 §4): a tool a step uses is joined to that step by a dashed teal line. It leaves the bottom of the
// step and enters the top of the tool, ignoring the ports the run lines use, and it is only drawn, never a Tab stop.

const FALLBACK = { width: 240, height: 76 };

export function ToolLinkEdge({ id, source, target }: EdgeProps) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to) return null;
  const a = from.internals.positionAbsolute;
  const b = to.internals.positionAbsolute;
  const fw = from.measured.width ?? FALLBACK.width;
  const fh = from.measured.height ?? FALLBACK.height;
  const tw = to.measured.width ?? FALLBACK.width;
  const x1 = a.x + fw / 2;
  const y1 = a.y + fh;
  const x2 = b.x + tw / 2;
  const y2 = b.y;
  const reach = Math.max(24, Math.abs(y2 - y1) / 2);
  return (
    <BaseEdge
      id={id}
      path={`M ${x1} ${y1} C ${x1} ${y1 + reach} ${x2} ${y2 - reach} ${x2} ${y2}`}
      interactionWidth={0}
    />
  );
}
