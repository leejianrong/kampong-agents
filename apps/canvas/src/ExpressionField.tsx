import { useId, useLayoutEffect, useRef, useState } from "react";
import { useAutoHeight } from "./useAutoHeight.js";
import {
  completeExpression,
  diagnoseExpression,
  type Completion,
  type ExpressionScope,
} from "@kampong/spec";

// A field for a JSONata expression (KAM-160, a slice of KAM-110). It says what is wrong as you type, in the
// words the spec loader would use (the checks live in packages/spec so the two cannot disagree), and offers
// the names in scope as you type a path: `vars.` lists the declared vars, `trigger.` its fields, a step name
// its known outputs. Without a `scope` (a version 1.0 spec, whose conditions are not expressions) it is a
// plain text field.
//
// `lines` is for a list of `name: expression` lines (a transform's values): each line's expression is checked
// and completed on its own.

export interface ExpressionFieldProps {
  label: string;
  /** The control's accessible name when the shown label is shorter ("Expression" for "Value 2 expression"). */
  accessibleName?: string;
  value: string;
  onChange: (value: string) => void;
  scope?: ExpressionScope;
  lines?: boolean;
  /** One expression that may span several lines: a textarea that grows with its text. */
  multiline?: boolean;
  placeholder?: string;
}

interface Piece {
  /** The expression text and where it starts inside the field's value. */
  text: string;
  offset: number;
  line: number;
}

/** The expressions in the field: the whole value, or the part after the first colon of each line. */
function piecesOf(value: string, lines: boolean): { pieces: Piece[]; malformed: number[] } {
  if (!lines) return { pieces: [{ text: value, offset: 0, line: 1 }], malformed: [] };
  const pieces: Piece[] = [];
  const malformed: number[] = [];
  let offset = 0;
  value.split("\n").forEach((raw, i) => {
    const colon = raw.indexOf(":");
    if (raw.trim() !== "" && colon < 0) malformed.push(i + 1);
    if (colon >= 0)
      pieces.push({ text: raw.slice(colon + 1), offset: offset + colon + 1, line: i + 1 });
    offset += raw.length + 1;
  });
  return { pieces, malformed };
}

export function ExpressionField({
  label,
  accessibleName,
  value,
  onChange,
  scope,
  lines = false,
  multiline = false,
  placeholder,
}: ExpressionFieldProps) {
  const id = useId();
  const listId = `${id}-options`;
  const problemsId = `${id}-problems`;
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const [explicit, setExplicit] = useState(false);
  const [active, setActive] = useState(0);
  const pendingCursor = useRef<number | null>(null);
  useAutoHeight(input, value, multiline || lines);

  useLayoutEffect(() => {
    if (pendingCursor.current !== null && input.current) {
      input.current.setSelectionRange(pendingCursor.current, pendingCursor.current);
      pendingCursor.current = null;
    }
  });

  const { pieces, malformed } = piecesOf(value, lines);
  const problems: string[] = [];
  if (scope) {
    for (const line of malformed) problems.push(`Line ${line}: write name: expression`);
    for (const piece of pieces) {
      for (const d of diagnoseExpression(piece.text, scope)) {
        const where = lines ? `Line ${piece.line}: ` : "";
        const at = d.position === undefined ? "" : ` (character ${d.position})`;
        problems.push(`${where}${d.message}${at}`);
      }
    }
  }

  // Completions come from the expression the cursor is in, so a `name:` before the colon gets none.
  let from = cursor;
  let options: Completion[] = [];
  if (scope && open) {
    const piece = pieces.find((p) => cursor >= p.offset && cursor <= p.offset + p.text.length);
    if (piece) {
      const found = completeExpression(piece.text, cursor - piece.offset, scope, { explicit });
      from = piece.offset + found.from;
      options = found.options;
    }
  }
  const showList = options.length > 0;
  const current = Math.min(active, Math.max(options.length - 1, 0));

  function sync(target: HTMLInputElement | HTMLTextAreaElement) {
    setCursor(target.selectionStart ?? target.value.length);
  }

  function accept(option: Completion) {
    const next = value.slice(0, from) + option.label + value.slice(cursor);
    pendingCursor.current = from + option.label.length;
    setCursor(from + option.label.length);
    setOpen(true);
    setExplicit(false);
    setActive(0);
    onChange(next);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === " " && event.ctrlKey) {
      event.preventDefault();
      setOpen(true);
      setExplicit(true);
      return;
    }
    if (!showList) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + options.length) % options.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept(options[current]!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  const shared = {
    id,
    ref: input,
    className: "md3-text-field",
    value,
    placeholder,
    spellCheck: false,
    autoComplete: "off",
    ...(multiline && { rows: 2 }),
    ...(accessibleName && { "aria-label": accessibleName }),
    "aria-invalid": problems.length > 0 || undefined,
    "aria-describedby": problems.length > 0 ? problemsId : undefined,
    ...(scope && {
      role: "combobox" as const,
      "aria-autocomplete": "list" as const,
      "aria-expanded": showList,
      "aria-controls": listId,
      "aria-activedescendant": showList ? `${listId}-${current}` : undefined,
    }),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setOpen(true);
      setExplicit(false);
      setActive(0);
      sync(e.target);
      onChange(e.target.value);
    },
    onKeyDown,
    onKeyUp: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      sync(e.currentTarget),
    onClick: (e: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => sync(e.currentTarget),
    onBlur: () => setOpen(false),
  };

  return (
    <div className="md3-field md3-expression">
      <label className="md3-field__label md3-label-large" htmlFor={id}>
        {label}
      </label>
      {lines || multiline ? <textarea {...shared} /> : <input {...shared} />}
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${accessibleName ?? label} suggestions`}
          className="md3-expression__list"
        >
          {options.map((option, i) => (
            <li
              key={option.label}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              className={`md3-expression__option${i === current ? " md3-expression__option--active" : ""}`}
              // mousedown, not click: the input would lose focus (and close the list) first.
              onMouseDown={(e) => {
                e.preventDefault();
                accept(option);
              }}
            >
              <span className="md3-body-medium">{option.label}</span>
              {option.detail && (
                <span className="md3-body-small md3-field__hint">{option.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {problems.length > 0 && (
        <ul id={problemsId} className="md3-expression__problems" aria-live="polite">
          {problems.map((problem) => (
            <li key={problem} className="md3-body-small">
              Problem: {problem}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
