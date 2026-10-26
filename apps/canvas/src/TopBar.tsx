import { useEffect, useRef, useState } from "react";
import type { ActionDescriptor } from "./actions.js";

// The top bar (KAM-214, KAM-246): where you are (a breadcrumb back to the workflows when there is a list of them,
// the workflow's name, whether it is saved), a switch between the Editor and the two panels you read results in
// (Test Run, Checks), the YAML drawer toggle and a menu for everything that is not frequent. It spans the window
// above the canvas and the side pane. A top app bar in M3.

export type SaveState = "saved" | "paused" | "failed";

const SAVE_WORDS: Record<SaveState, string> = {
  saved: "Saved",
  paused: "Saves paused: fix the error",
  failed: "Not saved",
};

export interface TopBarProps {
  name: string;
  saveState: SaveState;
  actions: ActionDescriptor[];
  onBack?: () => void;
  /** The canvas is what is on show: neither Test Run nor Checks is open. */
  editorActive?: boolean;
  /** Back to the canvas: closes Test Run or Checks. */
  onEditor?: () => void;
}

export function TopBar({ name, saveState, actions, onBack, editorActive, onEditor }: TopBarProps) {
  const run = actions.find((a) => a.surface === "run");
  const checks = actions.find((a) => a.id === "checks");
  const yaml = actions.find((a) => a.surface === "yaml");
  const menu = actions.filter((a) => a.surface === "menu");
  return (
    <header className="md3-runbar">
      {onBack && (
        <>
          <button
            className="md3-button md3-button-text md3-runbar__crumb"
            onClick={onBack}
            data-testid="back-to-specs"
          >
            Workflows
          </button>
          <span className="md3-runbar__slash" aria-hidden="true">
            /
          </span>
        </>
      )}
      <h1 className="md3-title-large md3-runbar__title" title={name}>
        {name}
      </h1>
      <span
        aria-live="polite"
        className={`md3-runbar__saved md3-runbar__saved--${saveState}`}
        data-testid="save-state"
      >
        {SAVE_WORDS[saveState]}
      </span>
      <span className="md3-runbar__spacer" />
      {(run || checks) && (
        <div className="md3-runbar__views" role="group" aria-label="View">
          {onEditor && (
            <button
              type="button"
              className="md3-runbar__view"
              aria-pressed={editorActive}
              data-testid="view-editor"
              onClick={onEditor}
            >
              Editor
            </button>
          )}
          {run && <ViewButton action={run} testId="view-run" />}
          {checks && <ViewButton action={checks} testId="view-checks" />}
        </div>
      )}
      <span className="md3-runbar__spacer" />
      {yaml && (
        <BarButton
          action={yaml}
          variant="tonal"
          className="md3-runbar__code"
          testId="yaml-drawer-toggle"
        />
      )}
      <ActionMenu items={menu} />
    </header>
  );
}

function ViewButton({ action, testId }: { action: ActionDescriptor; testId: string }) {
  return (
    <button
      type="button"
      className="md3-runbar__view"
      aria-pressed={action.pressed}
      aria-label={action.ariaLabel}
      title={action.title}
      data-testid={testId}
      onClick={action.run}
    >
      {action.label}
    </button>
  );
}

function BarButton({
  action,
  variant,
  className = "",
  testId,
}: {
  action: ActionDescriptor;
  variant: "tonal";
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={`md3-button md3-button-${variant} ${className}`}
      aria-pressed={action.pressed}
      aria-label={action.ariaLabel}
      aria-keyshortcuts={action.shortcut}
      title={action.title}
      data-testid={testId}
      onClick={action.run}
    >
      {action.label}
    </button>
  );
}

// A menu button: opens a list of actions, closes on Escape, a click outside, or a choice, and arrow keys move.
function ActionMenu({ items }: { items: ActionDescriptor[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    function onDown(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    const entries = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      entries[(to + entries.length) % entries.length]?.focus();
    };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(entries.length - 1);
    else if (event.key === "Tab") setOpen(false);
  }

  return (
    <div className="md3-menu" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className="md3-button md3-button-tonal md3-runbar__more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="canvas-menu"
        aria-label="Menu"
        title="Add a tool, edit the step list, import or export YAML"
        data-testid="menu-button"
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open && (
        <div id="canvas-menu" role="menu" aria-label="Workflow menu" className="md3-menu__list">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="md3-menu__item"
              title={item.title}
              aria-keyshortcuts={item.shortcut}
              onClick={() => {
                setOpen(false);
                item.run();
              }}
            >
              {item.label}
              {item.shortcut && (
                <span className="md3-menu__shortcut md3-label-small" aria-hidden="true">
                  {item.shortcut}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
