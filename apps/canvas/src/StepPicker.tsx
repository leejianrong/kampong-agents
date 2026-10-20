import { forwardRef, useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import {
  KIND_CATEGORIES,
  KIND_HELP,
  KIND_KEYWORDS,
  pickableKinds,
  type StepKind,
} from "./stepKinds.js";

// A searchable list of step kinds (KAM-213), used by the left palette and by the "+" on a line. A combobox
// (the search box) that owns a listbox of options: Arrow keys move through the rows, Enter chooses, Esc clears the
// search and then closes. Rows show the kind's one-line description (KAM-176).

export interface StepPickerProps {
  /** The spec's version, for which kinds are on offer. */
  version?: string;
  /** The accessible name of the search box. */
  label: string;
  onChoose: (kind: StepKind) => void;
  /** Esc with an empty search. */
  onEscape?: () => void;
  autoFocus?: boolean;
}

interface Option {
  kind: StepKind;
  label: string;
  what: string;
  category: string;
}

/** The kinds whose name, description or group contain every word typed, in the palette's order. */
export function filterKinds(version: string | undefined, query: string): Option[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const allowed = new Set(pickableKinds(version));
  return KIND_CATEGORIES.flatMap((c) =>
    c.kinds
      .filter((kind) => allowed.has(kind))
      .map((kind) => ({
        kind,
        label: KIND_HELP[kind].label,
        what: KIND_HELP[kind].what,
        category: c.label,
      })),
  ).filter((o) => {
    const text = `${o.label} ${o.what} ${o.category} ${KIND_KEYWORDS[o.kind]}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export const StepPicker = forwardRef<HTMLInputElement, StepPickerProps>(function StepPicker(
  { version, label, onChoose, onEscape, autoFocus },
  ref,
) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const options = useMemo(() => filterKinds(version, query), [version, query]);
  const at = Math.min(active, Math.max(options.length - 1, 0));
  const optionId = (kind: StepKind) => `${id}-${kind}`;
  const activeOption = options[at];

  useEffect(() => {
    if (!activeOption) return;
    document.getElementById(optionId(activeOption.kind))?.scrollIntoView?.({ block: "nearest" });
  }, [activeOption?.kind]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const last = options.length - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(at >= last ? 0 : at + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(at <= 0 ? last : at - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(last);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeOption) onChoose(activeOption.kind);
    } else if (event.key === "Escape") {
      if (query !== "") {
        event.preventDefault();
        event.stopPropagation();
        setQuery("");
        setActive(0);
      } else if (onEscape) {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }
    }
  }

  const groups = KIND_CATEGORIES.map((c) => ({
    ...c,
    options: options.filter((o) => c.kinds.includes(o.kind)),
  })).filter((g) => g.options.length > 0);

  return (
    <div className="md3-picker" data-testid="step-picker">
      <input
        ref={ref}
        type="text"
        role="combobox"
        className="md3-text-field md3-picker__search"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={options.length > 0}
        aria-controls={options.length > 0 ? `${id}-list` : undefined}
        aria-activedescendant={activeOption ? optionId(activeOption.kind) : undefined}
        placeholder="Search steps"
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {options.length > 0 ? (
        <div id={`${id}-list`} role="listbox" aria-label="Step kinds" className="md3-picker__list">
          {groups.map((g) => (
            <div key={g.id} role="group" aria-labelledby={`${id}-g-${g.id}`}>
              <div
                id={`${id}-g-${g.id}`}
                role="presentation"
                className="md3-picker__group md3-label-small"
              >
                {g.label}
              </div>
              {g.options.map((o) => (
                <div
                  key={o.kind}
                  id={optionId(o.kind)}
                  role="option"
                  aria-selected={o.kind === activeOption?.kind}
                  className="md3-picker__option"
                  data-kind={o.kind}
                  // Keep focus in the search box: the row is chosen, not focused.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActive(options.indexOf(o))}
                  onClick={() => onChoose(o.kind)}
                >
                  <span className="md3-title-small">{o.label}</span>
                  <span className="md3-body-small md3-picker__what">{o.what}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <p className="md3-body-small md3-field__hint" role="status">
          No step matches &ldquo;{query}&rdquo;.
        </p>
      )}
    </div>
  );
});
