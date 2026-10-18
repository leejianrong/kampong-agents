import { useState, type ReactNode } from "react";
import { listSteps, type AgentSpec } from "@kampong/spec";

// Delete a step or a tool from the Edit Steps list (KAM-171, ADR-0055). The server decides whether it can go:
// a step or tool that something still uses is refused with the list of places, which is shown here in plain
// words. There is no way to force it; the author changes those places first.

export interface RemoveReference {
  path: (string | number)[];
  kind: string;
  text: string;
  line?: number;
}

export type RemoveOutcome =
  | { success: true }
  | { success: false; messages: string[]; references: RemoveReference[]; blocked: boolean };

/** Says where a reference is, in the words of the canvas: the step or tool that holds it and the field. */
export function describeReference(spec: AgentSpec, ref: RemoveReference): string {
  const [, group, index, ...field] = ref.path;
  let where = "somewhere in the spec";
  let rest = field;
  if (group === "tools" && typeof index === "number") {
    where = `tool "${spec.agent.tools?.[index]?.name ?? index}"`;
  } else if (group === "workflow") {
    const owner = listSteps(spec)
      .filter((s) => s.path.every((seg, i) => ref.path[i] === seg))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (owner) {
      where = `step "${owner.name}"`;
      rest = ref.path.slice(owner.path.length);
    }
  }
  const in_ = rest.length > 0 ? `, ${rest.join(" ")}` : "";
  const line = ref.line !== undefined ? ` (line ${ref.line})` : "";
  return `${where}${in_}: ${ref.text}${line}`;
}

interface RowProps {
  spec: AgentSpec;
  noun: "step" | "tool";
  name: string;
  /** The small grey line under the name. */
  hint: ReactNode;
  /** What else goes with it, for the confirm message ("and the 2 steps inside it"). */
  extra?: string;
  disabled?: boolean;
  /** Omitted: the row has no Delete button. */
  onRemove?: () => Promise<RemoveOutcome>;
  /** The row's other buttons (Edit), shown before Delete. */
  children?: ReactNode;
}

/** A row of the steps or tools list with its Delete button, the confirm, and the list of what blocks it. */
export function DeletableRow({
  spec,
  noun,
  name,
  hint,
  extra,
  disabled,
  onRemove,
  children,
}: RowProps) {
  const [stage, setStage] = useState<"idle" | "confirm" | "busy" | "failed">("idle");
  const [outcome, setOutcome] = useState<Extract<RemoveOutcome, { success: false }> | null>(null);

  async function confirm() {
    if (!onRemove) return;
    setStage("busy");
    const result = await onRemove();
    if (result.success) {
      setStage("idle"); // the row is gone once the spec reloads
      return;
    }
    setOutcome(result);
    setStage("failed");
  }

  const close = () => {
    setStage("idle");
    setOutcome(null);
  };

  return (
    <li className="md3-secrets__row">
      <span className="md3-vars__name">
        <span className="md3-body-medium">{name}</span>
        <span className="md3-body-small md3-field__hint">{hint}</span>
      </span>
      <span className="md3-secrets__actions">
        {children}
        {onRemove && (
          <button
            type="button"
            className="md3-button md3-button-text"
            disabled={disabled || stage !== "idle"}
            aria-label={`Delete ${noun} ${name}`}
            onClick={() => setStage("confirm")}
          >
            Delete
          </button>
        )}
      </span>
      {(stage === "confirm" || stage === "busy") && (
        <div role="group" aria-label={`Delete ${noun} ${name}?`} className="md3-delete">
          <span className="md3-body-small">
            Delete {noun} "{name}"{extra ? ` ${extra}` : ""}? This changes the spec.
          </span>
          <span className="md3-delete__actions">
            <button
              type="button"
              className="md3-button md3-button-filled"
              disabled={stage === "busy"}
              onClick={() => void confirm()}
            >
              Delete {noun}
            </button>
            <button
              type="button"
              className="md3-button md3-button-text"
              disabled={stage === "busy"}
              onClick={close}
            >
              Cancel
            </button>
          </span>
        </div>
      )}
      {stage === "failed" && outcome && (
        <div role="alert" className="md3-delete">
          {outcome.blocked ? (
            <>
              <p className="md3-body-small">
                {outcome.references.length}{" "}
                {outcome.references.length === 1 ? "place uses" : "places use"} {noun} "{name}", so
                it cannot be deleted yet:
              </p>
              <ul className="md3-error-list">
                {outcome.references.map((ref, i) => (
                  <li key={i}>{describeReference(spec, ref)}</li>
                ))}
              </ul>
              <p className="md3-body-small">
                {noun === "tool"
                  ? "Pick another tool in those steps, or delete those steps first, then delete this tool."
                  : "Change those places to stop using this step, or delete them first, then delete this step."}
              </p>
            </>
          ) : (
            <ul className="md3-error-list">
              {outcome.messages.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          <button type="button" className="md3-button md3-button-text" onClick={close}>
            OK
          </button>
        </div>
      )}
    </li>
  );
}
