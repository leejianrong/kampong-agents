import { useEffect, useRef, useState } from "react";
import type { ActionDescriptor } from "./actions.js";

// The run bar (KAM-214): the workflow's name, whether it is saved, Run, the YAML drawer toggle and a menu for
// everything that is not frequent. It spans the window above the canvas and the side pane. A top app bar in M3.

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
}

export function TopBar({ name, saveState, actions, onBack }: TopBarProps) {
  const run = actions.find((a) => a.surface === "run");
  const yaml = actions.find((a) => a.surface === "yaml");
  const menu = actions.filter((a) => a.surface === "menu");
  return (
    <header className="md3-runbar">
      {onBack && (
        <button className="md3-button md3-button-text" onClick={onBack} data-testid="back-to-specs">
          ← Specs
        </button>
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
      {yaml && (
        <BarButton
          action={yaml}
          variant="tonal"
          className="md3-runbar__code"
          testId="yaml-drawer-toggle"
        />
      )}
      {run && <BarButton action={run} variant="filled" />}
      <ActionMenu items={menu} />
    </header>
  );
}

function BarButton({
  action,
  variant,
  className = "",
  testId,
}: {
  action: ActionDescriptor;
  variant: "tonal" | "filled";
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
              onClick={() => {
                setOpen(false);
                item.run();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
