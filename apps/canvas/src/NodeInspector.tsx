import { useEffect, useRef, useState } from "react";
import {
  listSteps,
  type AgentSpec,
  type ComponentCatalog,
  type Guardrails,
  type OutputReferenceOption,
  type PatchOp,
  type SpecNode,
  type Tool,
  type Trigger,
} from "@kampong/spec";
import { Panel, PanelError } from "./Panel.js";
import { StepsPanel } from "./StepsPanel.js";
import { ToolForm } from "./ToolForm.js";
import { TriggerPanel } from "./TriggerPanel.js";
import { GuardrailsForm } from "./GuardrailsForm.js";
import { RemovePrompt, useRemoveFlow, type RemoveOutcome } from "./DeleteControl.js";
import type { PinResult } from "./ComponentTrust.js";

// The inspector (KAM-211): selecting a node on the canvas opens its own form in the docked panel, the way n8n
// and Activepieces do. It reuses the forms the toolbar opens (the step forms of Edit Steps, the tool form, the
// trigger and guardrails forms) and the delete flow of KAM-171, so a step is edited and deleted the same way
// wherever it was reached from.
//
//   Esc            closes the inspector (and asks first when the form has unsaved input)
//   Delete         deletes the selected step or tool, after the usual confirm
//   Ctrl/Cmd + D   duplicates the selected step or tool, under a new name

export interface NodeInspectorProps {
  spec: AgentSpec;
  node: SpecNode;
  /** The tool form waits for the component catalog when the tool is a component. */
  catalogReady: boolean;
  catalog: ComponentCatalog | undefined;
  references: OutputReferenceOption[];
  onPinComponent?: (use: string, allowWider: boolean, digest: string) => Promise<PinResult>;
  onPatchSteps: (ops: PatchOp[]) => Promise<boolean>;
  onSaveTool: (index: number, tool: Tool) => Promise<boolean>;
  onSaveTrigger: (value: Trigger) => Promise<boolean>;
  onRemoveTrigger: () => Promise<boolean>;
  onSaveGuardrails: (value: Guardrails) => Promise<boolean>;
  onRemove: (
    op: { op: "step.remove"; step: string } | { op: "tool.remove"; tool: string },
  ) => Promise<RemoveOutcome>;
  /** Makes the copy. Resolves with messages when it was refused. */
  onDuplicate: () => Promise<string[] | void>;
  /** Close with nothing left to ask: after a save or a cancel. */
  onClose: () => void;
  /** Close because the user asked to (Esc, Close): the app asks first when there is unsaved input. */
  onRequestClose: () => void;
}

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function NodeInspector(props: NodeInspectorProps) {
  const { spec, node, onRequestClose } = props;
  const panel = useRef<HTMLElement>(null);
  const [duplicateErrors, setDuplicateErrors] = useState<string[]>([]);
  const [duplicating, setDuplicating] = useState(false);

  const stepName = node.kind === "workflow" ? String(node.data.step) : undefined;
  const toolName = node.kind === "tool" ? String(node.data.name) : undefined;
  const toolIndex =
    toolName === undefined ? -1 : (spec.agent.tools ?? []).findIndex((t) => t.name === toolName);
  const canActOn = stepName !== undefined || toolName !== undefined;

  const refs = listSteps(spec);
  const inside =
    stepName === undefined ? 0 : refs.filter((r) => r.within.includes(stepName)).length;
  const remove = useRemoveFlow(
    stepName !== undefined
      ? () => props.onRemove({ op: "step.remove", step: stepName })
      : toolName !== undefined
        ? () => props.onRemove({ op: "tool.remove", tool: toolName })
        : undefined,
  );

  async function duplicate() {
    if (!canActOn || duplicating) return;
    setDuplicating(true);
    setDuplicateErrors((await props.onDuplicate()) ?? []);
    setDuplicating(false);
  }

  // Keyboard focus follows selection: it moves to the panel, so Tab goes on to the form and Delete (which is
  // ignored inside a field) works straight away.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  // The latest handlers, read by one listener for the life of the inspector.
  const latest = useRef({ remove, duplicate, onRequestClose, canActOn });
  latest.current = { remove, duplicate, onRequestClose, canActOn };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const now = latest.current;
      if (event.key === "Escape") {
        event.preventDefault();
        if (now.remove.stage !== "idle" && now.remove.stage !== "busy") now.remove.close();
        else now.onRequestClose();
      } else if (event.key === "Delete" && !isEditable(event.target)) {
        if (!now.canActOn || now.remove.stage !== "idle") return;
        event.preventDefault();
        now.remove.start();
      } else if (
        event.code === "KeyD" &&
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey
      ) {
        if (!now.canActOn) return;
        event.preventDefault();
        void now.duplicate();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const title =
    stepName !== undefined
      ? `Step ${stepName}`
      : toolName !== undefined
        ? `Tool ${toolName}`
        : node.kind === "guardrails"
          ? "Guardrails"
          : "Trigger settings";

  const actions = canActOn && (
    <>
      <button
        type="button"
        className="md3-button md3-button-text"
        aria-label={`Duplicate ${stepName !== undefined ? "step" : "tool"} ${stepName ?? toolName}`}
        aria-keyshortcuts="Control+D Meta+D"
        title="Duplicate (Ctrl+D)"
        disabled={duplicating}
        onClick={() => void duplicate()}
      >
        Duplicate
      </button>
      <button
        type="button"
        className="md3-button md3-button-text"
        aria-label={`Delete ${stepName !== undefined ? "step" : "tool"} ${stepName ?? toolName}`}
        aria-keyshortcuts="Delete"
        title="Delete (Delete key)"
        disabled={remove.stage !== "idle"}
        onClick={remove.start}
      >
        Delete
      </button>
    </>
  );

  return (
    <Panel
      title={title}
      onClose={onRequestClose}
      actions={actions}
      panelRef={panel}
      testId="node-inspector"
      nodeId={node.id}
    >
      <div className="md3-inspector__prompts">
        {canActOn && (
          <RemovePrompt
            spec={spec}
            noun={stepName !== undefined ? "step" : "tool"}
            name={stepName ?? toolName ?? ""}
            extra={
              inside > 0 ? `and the ${inside} step${inside === 1 ? "" : "s"} inside it` : undefined
            }
            flow={remove}
            autoFocusConfirm
          />
        )}
        <PanelError messages={duplicateErrors} intro="The copy was not made:" />
      </div>
      {stepName !== undefined && (
        <StepsPanel
          key={stepName}
          spec={spec}
          only={stepName}
          onPatch={props.onPatchSteps}
          onDone={props.onClose}
        />
      )}
      {toolName !== undefined &&
        toolIndex >= 0 &&
        props.catalogReady &&
        spec.agent.tools?.[toolIndex] && (
          <ToolForm
            key={`${toolIndex}:${toolName}`}
            initial={spec.agent.tools[toolIndex]}
            components={props.catalog?.components}
            componentProblems={props.catalog?.problems}
            references={props.references}
            onPinComponent={props.onPinComponent}
            onSubmit={(tool) =>
              void props.onSaveTool(toolIndex, tool).then((saved) => saved && props.onClose())
            }
            onCancel={props.onClose}
          />
        )}
      {node.kind === "agent" && (
        <TriggerPanel
          version={spec.version}
          trigger={spec.agent.trigger}
          onSave={props.onSaveTrigger}
          onRemove={props.onRemoveTrigger}
        />
      )}
      {node.kind === "guardrails" && (
        <GuardrailsForm
          initial={spec.agent.guardrails}
          onSubmit={(value) =>
            void props.onSaveGuardrails(value).then((saved) => saved && props.onClose())
          }
          onCancel={props.onClose}
        />
      )}
    </Panel>
  );
}
