import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ExpressionScope } from "@kampong/spec";
import { pickerGroups, referenceText } from "./dataPicker.js";
import { useSamples } from "./sampleData.js";

// "Insert data" (KAM-218): a button beside an expression or prompt field that lists what the field may read, with the
// value the last run gave each, and puts the chosen reference where the cursor was. The names are the scope's, so what
// it inserts passes the expression check. With no run yet it lists the names the spec knows and offers a Replay run.

export interface InsertDataProps {
  scope: ExpressionScope | undefined;
  /** The id of the field's label, so a screen reader hears which field "Insert data" is for. */
  labelId: string;
  /** Called with the text to insert at the field's cursor. */
  onInsert: (text: string) => void;
  /** Wrap the reference in `{{ }}`, for a prompt that mixes text and values. */
  wrap?: boolean;
}

export function InsertData({ scope, labelId, onInsert, wrap = false }: InsertDataProps) {
  const { samples, replay } = useSamples();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const describedBy = labelId;
  const groups = useMemo(() => (scope ? pickerGroups(scope, samples) : []), [scope, samples]);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    function onDown(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  if (groups.length === 0) return null;

  const needle = query.trim().toLowerCase();
  const shown = groups
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (i) =>
          needle === "" ||
          i.path.toLowerCase().includes(needle) ||
          (i.preview ?? "").toLowerCase().includes(needle),
      ),
    }))
    .filter((g) => g.items.length > 0);
  // Whether the step outputs have values yet: the run's input alone is not a reason to call the picker filled.
  const stepGroups = groups.filter((g) => g.id.startsWith("step:"));
  const noValues = stepGroups.length > 0 && !stepGroups.some((g) => g.sampled);

  function close(returnFocus: boolean) {
    setOpen(false);
    setQuery("");
    if (returnFocus) button.current?.focus();
  }

  return (
    <div
      ref={root}
      className="md3-insertdata"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="md3-button md3-button-text md3-insertdata__toggle"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-describedby={describedBy}
        // The field keeps its cursor: the button must not take focus away on press.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        Insert data
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="Insert data"
          className="md3-insertdata__panel md3-elevated-surface"
          data-testid="insert-data"
        >
          <input
            ref={search}
            type="search"
            className="md3-text-field"
            aria-label="Search data"
            placeholder="Search names and values"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {noValues && (
            <p className="md3-body-small" data-testid="insert-data-empty">
              No values yet: these are the names this field can use.
              {replay && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="md3-button md3-button-tonal"
                    data-testid="insert-data-replay"
                    onClick={() => {
                      replay();
                      close(true);
                    }}
                  >
                    Run in Replay to see values
                  </button>
                </>
              )}
            </p>
          )}
          {shown.length === 0 && <p className="md3-body-small">Nothing matches.</p>}
          <div className="md3-insertdata__groups">
            {shown.map((group) => (
              <section key={group.id} aria-label={group.title}>
                <h4 className="md3-label-large md3-insertdata__title">
                  {group.title}
                  <span className="md3-body-small md3-insertdata__note">{group.note}</span>
                </h4>
                <ul className="md3-insertdata__items">
                  {group.items.map((item) => (
                    <li key={item.path}>
                      <button
                        type="button"
                        className="md3-insertdata__item"
                        data-testid="insert-data-item"
                        onClick={() => {
                          onInsert(referenceText(item.path, wrap));
                          close(false);
                        }}
                      >
                        <code className="md3-body-medium">{item.path}</code>
                        {item.preview !== undefined && item.preview !== "" && (
                          <span className="md3-body-small md3-insertdata__value">
                            {item.preview}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
