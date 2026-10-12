import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  checkExpression,
  completeExpression,
  type ExpressionScope,
  type ExpressionDiagnostic,
} from "@kampong/spec";

// An expression field with the spec validator's own check running as you type (KAN-1850). The check is
// `checkExpression` from @kampong/spec, which calls the same `parseExpression` and `readIssues` the validator
// runs when a spec loads, so a field this input accepts is one the spec will accept. A problem is shown under
// the field in M3 supporting text, with the position of a syntax error pointed at in the source. Typing a
// path offers the names readable at this point (trigger, vars, earlier steps, the loop variable) in an M3
// menu; arrow keys and Enter or Tab choose, Escape closes, Ctrl+Space opens it on an empty token.

export interface ExpressionInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** What the expression may read here. Without one only syntax is checked and nothing is suggested. */
  scope?: ExpressionScope;
  multiline?: boolean;
  placeholder?: string;
}

const NO_SCOPE: ExpressionScope = {
  vars: undefined,
  steps: [],
  earlier: [],
  local: [],
  trigger: [],
  stepFields: {},
};

function Pointer({ source, at }: { source: string; at: number }) {
  // The line the position is on, and a caret under the character.
  const start = source.lastIndexOf("\n", at - 1) + 1;
  const end = source.indexOf("\n", at);
  const line = source.slice(start, end === -1 ? undefined : end);
  return (
    <pre className="md3-expression__pointer" aria-hidden="true">
      {line}
      {"\n"}
      {" ".repeat(Math.max(0, at - start))}^
    </pre>
  );
}

function describe(d: ExpressionDiagnostic): string {
  if (d.position === undefined) return d.message;
  const where =
    d.line !== undefined && d.column !== undefined
      ? `line ${d.line}, column ${d.column}`
      : `character ${d.position}`;
  return `${d.message} (${where})`;
}

export function ExpressionInput({
  label,
  value,
  onChange,
  scope,
  multiline = false,
  placeholder,
}: ExpressionInputProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const listId = `${id}-list`;
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const pendingCursor = useRef<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const [forced, setForced] = useState(false);
  const [active, setActive] = useState(0);
  const effective = scope ?? NO_SCOPE;

  const problems = useMemo(
    () => (scope === undefined ? syntaxOnly(value) : checkExpression(value, effective)),
    [value, scope, effective],
  );
  const completion = useMemo(() => {
    if (scope === undefined) return { from: 0, to: 0, items: [] };
    const result = completeExpression(value, cursor, effective);
    // Nothing typed yet: offer names only when asked for with Ctrl+Space.
    return result.from === result.to && !forced ? { ...result, items: [] } : result;
  }, [value, cursor, scope, effective, forced]);
  const showMenu = open && completion.items.length > 0;
  const activeIndex = Math.min(active, Math.max(0, completion.items.length - 1));

  useLayoutEffect(() => {
    if (pendingCursor.current !== null && ref.current) {
      ref.current.setSelectionRange(pendingCursor.current, pendingCursor.current);
      pendingCursor.current = null;
    }
  });

  function accept(index: number) {
    const item = completion.items[index];
    if (!item) return;
    onChange(value.slice(0, completion.from) + item.insert + value.slice(completion.to));
    const next = completion.from + item.insert.length;
    pendingCursor.current = next;
    setCursor(next);
    setOpen(false);
    setForced(false);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === " " && event.ctrlKey) {
      event.preventDefault();
      setForced(true);
      setOpen(true);
      return;
    }
    if (!showMenu) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((activeIndex + 1) % completion.items.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((activeIndex - 1 + completion.items.length) % completion.items.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept(activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setForced(false);
    }
  }

  const common = {
    id,
    ref,
    className: `md3-text-field md3-expression__input${problems.length > 0 ? " md3-text-field--error" : ""}`,
    value,
    placeholder,
    spellCheck: false,
    autoComplete: "off",
    "aria-invalid": problems.length > 0,
    "aria-describedby": problems.length > 0 ? helpId : undefined,
    role: "combobox" as const,
    "aria-expanded": showMenu,
    "aria-controls": showMenu ? listId : undefined,
    "aria-autocomplete": "list" as const,
    "aria-activedescendant": showMenu ? `${id}-opt-${activeIndex}` : undefined,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(event.target.value);
      setCursor(event.target.selectionStart ?? event.target.value.length);
      setActive(0);
      setOpen(true);
      setForced(false);
    },
    onKeyDown: handleKeyDown,
    onKeyUp: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        setCursor(event.currentTarget.selectionStart ?? 0);
      }
    },
    onClick: (event: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setCursor(event.currentTarget.selectionStart ?? 0),
    onBlur: () => {
      setOpen(false);
      setForced(false);
    },
  };

  return (
    <div className="md3-field md3-expression">
      <label htmlFor={id} className="md3-field__label md3-label-large">
        {label}
      </label>
      {multiline ? <textarea rows={3} {...common} /> : <input {...common} />}
      {showMenu && (
        <ul id={listId} role="listbox" className="md3-menu" aria-label={`Names for ${label}`}>
          {completion.items.map((item, i) => (
            <li
              key={item.insert}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={
                i === activeIndex ? "md3-menu__item md3-menu__item--active" : "md3-menu__item"
              }
              // mousedown, not click: the input's blur would close the menu before a click lands.
              onMouseDown={(event) => {
                event.preventDefault();
                accept(i);
              }}
            >
              <span className="md3-menu__label">{item.insert}</span>
              <span className="md3-menu__detail">{item.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {problems.length > 0 && (
        <div id={helpId} className="md3-supporting-text md3-supporting-text--error">
          {problems.map((problem) => (
            <div key={problem.message} data-testid="expression-problem">
              <span>{describe(problem)}</span>
              {problem.position !== undefined && <Pointer source={value} at={problem.position} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Without a scope there is nothing to say about names, but a syntax error is a syntax error anywhere.
function syntaxOnly(value: string): ExpressionDiagnostic[] {
  return checkExpression(value, { ...NO_SCOPE, vars: [], steps: [], ingress: false }).filter(
    (d) => d.position !== undefined || /empty|characters long|not available/.test(d.message),
  );
}
