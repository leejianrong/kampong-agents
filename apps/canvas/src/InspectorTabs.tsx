import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

// The inspector shell (KAM-212): every node form shows the same four tabs, the way n8n's node view and
// Activepieces' inspector do. Setup holds the few fields most people need, Settings the rest (error handling,
// retries, temperature). Output and Test are placeholders until the run-status work (KAM-190, KAM-218, KAM-219)
// has real run data to show: they say so plainly and show nothing invented.
//
// A form renders <InspectorTabs> inside its own <form>, above its PanelFooter. All four panels stay mounted and
// the inactive ones are `hidden`, so one submit saves every tab and nothing typed on a tab is lost by leaving it.
//
// The ARIA tabs pattern: role=tablist / tab / tabpanel, roving tabindex, and Left/Right (wrapping), Home and End
// move focus and select. Tab leaves the list for the open panel.

export type InspectorTabId = "setup" | "output" | "test" | "settings";

const TABS: readonly { id: InspectorTabId; label: string }[] = [
  { id: "setup", label: "Setup" },
  { id: "output", label: "Output" },
  { id: "test", label: "Test" },
  { id: "settings", label: "Settings" },
];

export const NO_RUN_YET = "Run the workflow to see output";

export interface InspectorTabsProps {
  /** The fields most people need. */
  setup: ReactNode;
  /** The rest. Omit for a step with nothing more to adjust. */
  settings?: ReactNode;
  /** The tab open first. */
  initial?: InspectorTabId;
}

function RunPlaceholder({ heading, hint }: { heading: string; hint: string }) {
  return (
    <div className="md3-inspector-tabs__empty" data-testid="run-placeholder">
      <span className="md3-title-small">{heading}</span>
      <p className="md3-body-medium">{NO_RUN_YET}</p>
      <p className="md3-body-small md3-field__hint">{hint}</p>
    </div>
  );
}

export function InspectorTabs({ setup, settings, initial = "setup" }: InspectorTabsProps) {
  const base = useId();
  const [active, setActive] = useState<InspectorTabId>(initial);
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});

  function select(id: InspectorTabId, focus: boolean) {
    setActive(id);
    if (focus) tabs.current[id]?.focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    const at = TABS.findIndex((t) => t.id === active);
    let next: number;
    if (event.key === "ArrowRight") next = (at + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (at - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    select(TABS[next]!.id, true);
  }

  const idOf = (kind: "tab" | "panel", id: InspectorTabId) => `${base}-${kind}-${id}`;

  return (
    <div className="md3-inspector-tabs">
      <div
        role="tablist"
        aria-label="Step sections"
        className="md3-inspector-tabs__list"
        onKeyDown={onKeyDown}
      >
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            ref={(el) => {
              tabs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={idOf("tab", id)}
            aria-selected={active === id}
            aria-controls={idOf("panel", id)}
            tabIndex={active === id ? 0 : -1}
            className="md3-inspector-tabs__tab"
            onClick={() => select(id, false)}
          >
            {label}
          </button>
        ))}
      </div>
      {TABS.map(({ id }) => (
        <div
          key={id}
          role="tabpanel"
          id={idOf("panel", id)}
          aria-labelledby={idOf("tab", id)}
          hidden={active !== id}
          tabIndex={0}
          className="md3-inspector-tabs__panel"
        >
          {id === "setup" && setup}
          {id === "output" && (
            <RunPlaceholder
              heading="What this step produced"
              hint="After a run, the step's output shows here."
            />
          )}
          {id === "test" && (
            <RunPlaceholder
              heading="What this step received"
              hint="After a run, the input the step got shows here."
            />
          )}
          {id === "settings" &&
            (settings ?? (
              <p className="md3-body-medium md3-field__hint" data-testid="no-settings">
                Nothing more to adjust for this step.
              </p>
            ))}
        </div>
      ))}
    </div>
  );
}
