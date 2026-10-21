import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { commandName, type ActionDescriptor } from "./actions.js";

// The command palette (KAM-215): Ctrl/Cmd+K opens a modal dialog with a search box (a combobox) that owns a
// listbox of commands. The commands are the canvas's own action list (actions.ts) plus a "Go to <node>" entry per
// node of the spec, so no verb is spelled twice. Arrow keys move, Enter runs, Esc closes. Focus is held in the
// box while it is open and goes back to where it was when it closes.

export interface PaletteNode {
  id: string;
  kind: string;
  data: Record<string, unknown>;
  parent?: string;
}

export interface CommandPaletteProps {
  actions: ActionDescriptor[];
  nodes: PaletteNode[];
  onGoTo: (nodeId: string) => void;
  onClose: () => void;
}

interface Command {
  id: string;
  label: string;
  hint?: string;
  words: string;
  group: "Commands" | "Go to";
  run: () => void;
}

/** "Go to step parse", "Go to tool fetch_price": one entry per node, named the way the canvas names it. */
export function goToLabel(node: PaletteNode): string {
  const name = String(node.data.name ?? node.data.step ?? node.id);
  if (node.kind === "agent") return "Go to trigger";
  if (node.kind === "guardrails") return "Go to guardrails";
  if (node.kind === "tool") return `Go to tool ${name}`;
  return `Go to step ${name}`;
}

/** The commands whose label or keywords contain every word typed, in list order. */
export function filterCommands<T extends { words: string }>(commands: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((c) => words.every((w) => c.words.includes(w)));
}

export function CommandPalette({ actions, nodes, onGoTo, onClose }: CommandPaletteProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  // Focus returns to what had it before the palette opened (a node of the canvas when nothing did).
  const before = useRef<Element | null>(document.activeElement);
  function close() {
    const previous = before.current;
    if (previous instanceof HTMLElement && previous.isConnected && previous !== document.body) {
      previous.focus();
    } else {
      document.querySelector<HTMLElement>(".react-flow__node.selected, .react-flow__node")?.focus();
    }
    onClose();
  }

  const commands = useMemo<Command[]>(() => {
    const verbs: Command[] = actions
      .filter((a) => a.id !== "commands" && !a.disabled)
      .map((a) => {
        const label = commandName(a);
        return {
          id: `action-${a.id}`,
          label,
          ...(a.shortcut && { hint: a.shortcut }),
          words:
            `${label} ${a.label} ${a.ariaLabel ?? ""} ${(a.keywords ?? []).join(" ")}`.toLowerCase(),
          group: "Commands" as const,
          run: a.run,
        };
      });
    const jumps: Command[] = nodes.map((n) => {
      const label = goToLabel(n);
      return {
        id: `goto-${n.id}`,
        label,
        ...(n.parent && { hint: `in ${n.parent.replace(/^workflow:/, "")}` }),
        words: `${label} ${n.id} jump select`.toLowerCase(),
        group: "Go to" as const,
        run: () => onGoTo(n.id),
      };
    });
    return [...verbs, ...jumps];
  }, [actions, nodes, onGoTo]);

  const options = useMemo(() => filterCommands(commands, query), [commands, query]);
  const at = Math.min(active, Math.max(options.length - 1, 0));
  const current = options[at];
  const optionId = (c: Command) => `${id}-${c.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  useEffect(() => {
    if (current) document.getElementById(optionId(current))?.scrollIntoView?.({ block: "nearest" });
  }, [current?.id]);

  function choose(command: Command | undefined) {
    if (!command) return;
    // Closing first lets focus go back; the command then runs and may take focus itself (a form opens).
    close();
    command.run();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const last = options.length - 1;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      // The box is the dialog's one stop: focus stays in it.
      event.preventDefault();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(at >= last ? 0 : at + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(at <= 0 ? last : at - 1);
    } else if (event.key === "Home" && event.target === input.current && query === "") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && event.target === input.current && query === "") {
      event.preventDefault();
      setActive(last);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(current);
    }
  }

  const groups = (["Commands", "Go to"] as const)
    .map((g) => ({ name: g, items: options.filter((o) => o.group === g) }))
    .filter((g) => g.items.length > 0);

  return (
    <div
      className="md3-modal-backdrop md3-cmdk-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="md3-cmdk"
        data-testid="command-palette"
        onKeyDown={onKeyDown}
      >
        <input
          ref={input}
          type="text"
          role="combobox"
          className="md3-text-field md3-cmdk__search"
          aria-label="Search commands"
          aria-autocomplete="list"
          aria-expanded={options.length > 0}
          aria-controls={options.length > 0 ? `${id}-list` : undefined}
          aria-activedescendant={current ? optionId(current) : undefined}
          placeholder="Search commands and steps"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        {options.length > 0 ? (
          <div id={`${id}-list`} role="listbox" aria-label="Commands" className="md3-cmdk__list">
            {groups.map((g) => (
              <div key={g.name} role="group" aria-labelledby={`${id}-g-${g.name.replace(" ", "")}`}>
                <div
                  id={`${id}-g-${g.name.replace(" ", "")}`}
                  role="presentation"
                  className="md3-picker__group md3-label-small"
                >
                  {g.name}
                </div>
                {g.items.map((o) => (
                  <div
                    key={o.id}
                    id={optionId(o)}
                    role="option"
                    aria-selected={o.id === current?.id}
                    className="md3-cmdk__option"
                    data-command={o.id}
                    // Keep focus in the search box: the row is chosen, not focused.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => setActive(options.indexOf(o))}
                    onClick={() => choose(o)}
                  >
                    <span className="md3-body-large">{o.label}</span>
                    {o.hint && <span className="md3-label-small md3-cmdk__hint">{o.hint}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="md3-body-small md3-field__hint" role="status">
            No command matches &ldquo;{query}&rdquo;.
          </p>
        )}
      </div>
    </div>
  );
}
