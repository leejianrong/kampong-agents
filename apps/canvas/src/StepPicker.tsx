import { forwardRef, useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { NodeIcon, type Category, type IconName } from "./nodeCard.js";
import {
  CONNECTORS_GROUP,
  KIND_CATEGORIES,
  KIND_HELP,
  KIND_KEYWORDS,
  pickableKinds,
  type ConnectorOption,
  type StepKind,
  type ToolStart,
} from "./stepKinds.js";

// A searchable set of step tiles (KAM-213, KAM-244), used by the left palette and by the "+" on a line. A combobox
// (the search box) that owns a listbox of options: Arrow keys move through the tiles, Enter chooses, Esc clears the
// search and then closes. A tile's description is its tooltip and its accessible description. The palette adds a
// fourth group, Connectors, whose tiles open Add Tool; a line's "+" offers steps only, since a tool has no place
// on a line.

export interface StepPickerProps {
  /** The spec's version, for which kinds are on offer. */
  version?: string;
  /** The accessible name of the search box. */
  label: string;
  onChoose: (kind: StepKind) => void;
  /** The connectors to show as a fourth group; without them there is none. */
  connectors?: ConnectorOption[];
  onChooseConnector?: (start: ToolStart) => void;
  /** Where a chosen step will go, in words: shown as a chip above the tiles. */
  where?: string;
  /** Esc with an empty search. */
  onEscape?: () => void;
  autoFocus?: boolean;
}

interface Option {
  key: string;
  kind?: StepKind;
  connector?: ConnectorOption;
  label: string;
  what: string;
  group: string;
  groupLabel: string;
}

/** The icon and colour of each kind's tile: the same as the card it makes on the canvas. */
const KIND_TILE: Record<StepKind, { icon: IconName; category: Category }> = {
  action: { icon: "sparkle", category: "ai" },
  tool: { icon: "bolt", category: "tool" },
  approval: { icon: "person", category: "approval" },
  transform: { icon: "transform", category: "data" },
  validate: { icon: "shield", category: "data" },
  dedupe: { icon: "copy", category: "data" },
  foreach: { icon: "loop", category: "flow" },
  branch: { icon: "branch", category: "flow" },
  stop: { icon: "stop", category: "flow" },
  condition: { icon: "split", category: "flow" },
};

/** The tiles whose name, description or group contain every word typed, in the palette's order. */
export function filterKinds(
  version: string | undefined,
  query: string,
  connectors: readonly ConnectorOption[] = [],
): Option[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const allowed = new Set(pickableKinds(version));
  const steps: Option[] = KIND_CATEGORIES.flatMap((c) =>
    c.kinds
      .filter((kind) => allowed.has(kind))
      .map((kind) => ({
        key: kind,
        kind,
        label: KIND_HELP[kind].label,
        what: KIND_HELP[kind].what,
        group: c.id,
        groupLabel: c.label,
      })),
  );
  const tools: Option[] = connectors.map((c) => ({
    key: `connector:${c.id}`,
    connector: c,
    label: c.label,
    what: c.what,
    group: CONNECTORS_GROUP.id,
    groupLabel: CONNECTORS_GROUP.label,
  }));
  return [...steps, ...tools].filter((o) => {
    const extra = o.kind ? KIND_KEYWORDS[o.kind] : (o.connector?.keywords ?? "");
    const text = `${o.label} ${o.what} ${o.groupLabel} ${extra}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

function Tile({ option }: { option: Option }) {
  if (option.kind) {
    const { icon, category } = KIND_TILE[option.kind];
    return (
      <span className={`kg-card--${category} md3-picker__tilewrap`} aria-hidden="true">
        <span className="kg-card__tile md3-picker__tile">
          <NodeIcon name={icon} />
        </span>
      </span>
    );
  }
  const brand = option.connector?.brand;
  return (
    <span className="kg-card--tool md3-picker__tilewrap" aria-hidden="true">
      <span
        className={`kg-card__tile md3-picker__tile${brand ? " kg-card__tile--brand" : ""}`}
        {...(brand?.color !== undefined && { style: { background: brand.color, color: "#fff" } })}
      >
        {brand ? (
          <span className="kg-card__letter">{brand.label}</span>
        ) : (
          <NodeIcon name="wrench" />
        )}
      </span>
    </span>
  );
}

export const StepPicker = forwardRef<HTMLInputElement, StepPickerProps>(function StepPicker(
  { version, label, onChoose, connectors, onChooseConnector, where, onEscape, autoFocus },
  ref,
) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const options = useMemo(
    () => filterKinds(version, query, onChooseConnector ? connectors : undefined),
    [version, query, connectors, onChooseConnector],
  );
  const at = Math.min(active, Math.max(options.length - 1, 0));
  const optionId = (key: string) => `${id}-${key.replace(/[^a-z0-9_-]/gi, "_")}`;
  const activeOption = options[at];

  function choose(option: Option) {
    if (option.kind) onChoose(option.kind);
    else if (option.connector) onChooseConnector?.(option.connector.start);
  }

  useEffect(() => {
    if (!activeOption) return;
    document.getElementById(optionId(activeOption.key))?.scrollIntoView?.({ block: "nearest" });
  }, [activeOption?.key]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const last = options.length - 1;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setActive(at >= last ? 0 : at + 1);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
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
      if (activeOption) choose(activeOption);
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

  const groups: { id: string; label: string; options: Option[] }[] = [];
  for (const o of options) {
    const group = groups.find((g) => g.id === o.group);
    if (group) group.options.push(o);
    else groups.push({ id: o.group, label: o.groupLabel, options: [o] });
  }

  return (
    <div className="md3-picker" data-testid="step-picker">
      {where !== undefined && (
        <span className="md3-picker__where md3-label-small" data-testid="picker-where">
          {where}
        </span>
      )}
      <input
        ref={ref}
        type="text"
        role="combobox"
        className="md3-text-field md3-picker__search"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={options.length > 0}
        aria-controls={options.length > 0 ? `${id}-list` : undefined}
        aria-activedescendant={activeOption ? optionId(activeOption.key) : undefined}
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
              <div className="md3-picker__tiles" role="presentation">
                {g.options.map((o) => (
                  <div
                    key={o.key}
                    id={optionId(o.key)}
                    role="option"
                    aria-selected={o === activeOption}
                    aria-description={o.what}
                    title={o.what}
                    className="md3-picker__option"
                    data-kind={o.kind ?? o.key}
                    // Keep focus in the search box: the tile is chosen, not focused.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => setActive(options.indexOf(o))}
                    onClick={() => choose(o)}
                  >
                    <Tile option={o} />
                    <span className="md3-label-large md3-picker__label">{o.label}</span>
                  </div>
                ))}
              </div>
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
