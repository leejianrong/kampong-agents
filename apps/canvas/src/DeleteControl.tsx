import { useEffect, useRef, useState, type ReactNode } from "react";
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

/** A refused rename in plain words, to show next to the name field. */
export function renameErrorWords(
  error: { code?: string; message: string },
  noun: "step" | "tool",
  to: string,
): string {
  switch (error.code) {
    case "name_taken":
      return `The name "${to}" is already used by another ${noun}. Pick a different name.`;
    case "invalid_name":
      return `"${to}" cannot be used as a name: ${error.message.replace(/^".*?" /, "")}`;
    case "unrewritable":
      return `One place that uses the old name cannot be updated automatically. Change it by hand, then rename. (${error.message})`;
    case "stale":
      return "The spec changed in the meantime. Close this and try again.";
    case undefined:
      return `The spec would no longer be valid with that name (${error.message}).`;
    default:
      return error.message;
  }
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
  /** Omitted: the row has no Rename button (KAM-172). Resolves with messages when the name is refused. */
  onRename?: (to: string) => Promise<RenameOutcome>;
  /** How many places use this name today, for "3 places will be updated". */
  usedIn?: number;
  /** Omitted: no Move up / Move down buttons (KAM-174). */
  move?: MoveControl;
}

export type MoveOutcome = { success: true } | { success: false; messages: string[] };

/** Move up and down within the step's own list; the run order is the list order (KAM-174). */
export interface MoveControl {
  canUp: boolean;
  canDown: boolean;
  run: (direction: "up" | "down") => Promise<MoveOutcome>;
}

/**
 * A refused move in plain words. The server names each pair as "<reader> reads <step>" inside parentheses
 * (`breaks_references`); a scope refusal from the validator is passed on after a short lead-in.
 */
export function moveErrorWords(error: { code?: string; message: string }): string[] {
  if (error.code === "breaks_references") {
    const pairs = /\(([^)]*)\)/.exec(error.message)?.[1]?.split(", ") ?? [];
    const words = pairs.flatMap((pair) => {
      const [reader, writer] = pair.split(" reads ");
      return reader && writer
        ? [`"${reader}" reads "${writer}", so "${writer}" has to stay before it.`]
        : [];
    });
    if (words.length > 0) return words;
    return [
      `Moving it there would put a step where it cannot see something it needs: ${error.message}`,
    ];
  }
  if (error.code === "stale")
    return ["The spec changed in the meantime. Close this and try again."];
  if (error.code === undefined) {
    return [`The spec would no longer be valid after the move (${error.message}).`];
  }
  return [error.message];
}

export type RenameOutcome = { success: true } | { success: false; messages: string[] };

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
  onRename,
  usedIn = 0,
  move,
}: RowProps) {
  const [moveErrors, setMoveErrors] = useState<string[]>([]);
  const [moving, setMoving] = useState(false);
  async function runMove(direction: "up" | "down") {
    if (!move) return;
    setMoving(true);
    const result = await move.run(direction);
    setMoving(false);
    setMoveErrors(result.success ? [] : result.messages);
  }
  const remove = useRemoveFlow(onRemove);
  const { stage } = remove;
  const [renaming, setRenaming] = useState<{
    draft: string;
    errors: string[];
    busy: boolean;
  } | null>(null);

  // The docked panel is short at 900x700: keep the form, its message and its buttons in view when it opens
  // and when a refusal adds a line.
  const renameForm = useRef<HTMLFormElement>(null);
  const shown = renaming !== null;
  const errorCount = renaming?.errors.length ?? 0;
  useEffect(() => {
    if (shown) renameForm.current?.scrollIntoView?.({ block: "nearest" });
  }, [shown, errorCount]);

  async function saveRename(event: React.FormEvent) {
    event.preventDefault();
    if (!onRename || !renaming) return;
    const to = renaming.draft.trim();
    if (to === name) {
      setRenaming(null);
      return;
    }
    setRenaming({ ...renaming, busy: true });
    const result = await onRename(to);
    // On success the spec reloads with the new name (and the row with it); on a refusal the input stays.
    setRenaming(
      result.success ? null : { draft: renaming.draft, errors: result.messages, busy: false },
    );
  }
  return (
    <li className="md3-secrets__row">
      <span className="md3-vars__name">
        <span className="md3-body-medium">{name}</span>
        <span className="md3-body-small md3-field__hint">{hint}</span>
      </span>
      <span className="md3-secrets__actions">
        {children}
        {move && (
          <>
            <button
              type="button"
              className="md3-button md3-button-text"
              disabled={disabled || moving || !move.canUp}
              title={move.canUp ? undefined : "Already first in its list"}
              aria-label={`Move ${noun} ${name} up`}
              onClick={() => void runMove("up")}
            >
              Up
            </button>
            <button
              type="button"
              className="md3-button md3-button-text"
              disabled={disabled || moving || !move.canDown}
              title={move.canDown ? undefined : "Already last in its list"}
              aria-label={`Move ${noun} ${name} down`}
              onClick={() => void runMove("down")}
            >
              Down
            </button>
          </>
        )}
        {onRename && (
          <button
            type="button"
            className="md3-button md3-button-text"
            disabled={disabled || stage !== "idle" || renaming !== null}
            aria-label={`Rename ${noun} ${name}`}
            onClick={() => setRenaming({ draft: name, errors: [], busy: false })}
          >
            Rename
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            className="md3-button md3-button-text"
            disabled={disabled || stage !== "idle"}
            aria-label={`Delete ${noun} ${name}`}
            onClick={remove.start}
          >
            Delete
          </button>
        )}
      </span>
      {moveErrors.length > 0 && (
        <div role="alert" className="md3-delete">
          <p className="md3-body-small">"{name}" was not moved:</p>
          <ul className="md3-error-list">
            {moveErrors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <button
            type="button"
            className="md3-button md3-button-text"
            onClick={() => setMoveErrors([])}
          >
            OK
          </button>
        </div>
      )}
      {renaming && (
        <form
          ref={renameForm}
          onSubmit={(e) => void saveRename(e)}
          aria-label={`Rename ${noun} ${name}?`}
          className="md3-delete"
        >
          <label className="md3-field">
            <span className="md3-body-small md3-field__label">New name</span>
            <input
              className="md3-text-field"
              value={renaming.draft}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={renaming.errors.length > 0}
              onChange={(e) => setRenaming({ ...renaming, draft: e.target.value, errors: [] })}
            />
          </label>
          <span className="md3-body-small md3-field__hint">
            {usedIn === 0
              ? `Nothing else uses this ${noun}'s name.`
              : `${usedIn} ${usedIn === 1 ? "place" : "places"} will be updated to the new name.`}
          </span>
          {renaming.errors.length > 0 && (
            <ul role="alert" className="md3-error-list">
              {renaming.errors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          <span className="md3-delete__actions">
            <button type="submit" className="md3-button md3-button-filled" disabled={renaming.busy}>
              Rename {noun}
            </button>
            <button
              type="button"
              className="md3-button md3-button-text"
              disabled={renaming.busy}
              onClick={() => setRenaming(null)}
            >
              Cancel
            </button>
          </span>
        </form>
      )}
      <RemovePrompt spec={spec} noun={noun} name={name} extra={extra} flow={remove} />
    </li>
  );
}

export interface RemoveFlow {
  stage: "idle" | "confirm" | "busy" | "failed";
  setStage: (stage: RemoveFlow["stage"]) => void;
  outcome: Extract<RemoveOutcome, { success: false }> | null;
  /** Shows the confirm. */
  start: () => void;
  confirm: () => Promise<void>;
  close: () => void;
}

/** The delete flow of KAM-171 (confirm, then the server decides, a refusal lists what uses the name), shared by the row's Delete button and the node inspector's. */
export function useRemoveFlow(onRemove?: () => Promise<RemoveOutcome>): RemoveFlow {
  const [stage, setStage] = useState<RemoveFlow["stage"]>("idle");
  const [outcome, setOutcome] = useState<RemoveFlow["outcome"]>(null);

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

  return { stage, setStage, outcome, start: () => setStage("confirm"), confirm, close };
}

/** The confirm and the refusal of a delete: what goes, and when the server refuses, the places that still use it. */
export function RemovePrompt({
  spec,
  noun,
  name,
  extra,
  flow,
  autoFocusConfirm,
}: {
  spec: AgentSpec;
  noun: "step" | "tool";
  name: string;
  extra?: string | undefined;
  flow: RemoveFlow;
  autoFocusConfirm?: boolean;
}) {
  const { stage, outcome, confirm, close } = flow;
  return (
    <>
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
              autoFocus={autoFocusConfirm}
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
    </>
  );
}
