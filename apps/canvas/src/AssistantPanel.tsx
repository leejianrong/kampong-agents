import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type {
  ApiClient,
  ApplyOpsResponse,
  AssistantAnswer,
  AssistantDiffDto,
  AssistantStatus,
} from "./api.js";

// The workflow assistant's panel (KAM-250, ADR-0060): describe what you want, read the plan, press Apply. Nothing
// reaches the canvas until Apply, and one Undo puts the file back as it was before that Apply. The plan arrives as
// operations already proved against the spec (KAM-249), so Apply is the same write every other edit makes.

type Api = Pick<ApiClient, "assistantStatus" | "askAssistant" | "applyOps" | "replaceSource">;

export interface AssistantPanelProps {
  api: Api;
  /** The workflow file as it is on screen now: what Undo goes back to. */
  source: string;
  /** Called after a write, so the canvas shows it. */
  onChanged: () => Promise<void>;
  /** The node ids the last apply added, for the canvas to mark New; empty clears them. */
  onMarkNew: (ids: string[]) => void;
  /** Back to the step list. */
  onClose: () => void;
  hidden?: boolean;
  /**
   * A description to send as soon as the assistant is ready (KAM-205): the empty state's "Build it for me" starts a
   * blank workflow, opens this panel and hands the text over. A new `nonce` sends it again.
   */
  initialPrompt?: { text: string; nonce: number };
}

type Plan = Extract<AssistantAnswer, { success: true }>;
type PlanState = "pending" | "applied" | "undone" | "discarded";

type Message =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "plan"; plan: Plan; state: PlanState; before?: string; revision?: string }
  | { id: number; kind: "error"; text: string; details?: string[] }
  | { id: number; kind: "note"; text: string };

/** A message before it has an id; `Omit` does not distribute over a union, so each member is spelled out. */
type NewMessage = Message extends infer M
  ? M extends { id: number }
    ? Omit<M, "id">
    : never
  : never;

const NOTICE_KEY = "kampong.assistant.noticed";

function noticed(): boolean {
  try {
    return localStorage.getItem(NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(): void {
  try {
    localStorage.setItem(NOTICE_KEY, "1");
  } catch {
    // Without storage the notice simply shows each visit.
  }
}

const KIND_WORD: Record<string, string> = {
  step: "Step",
  tool: "Tool",
  var: "Variable",
  agent: "Workflow settings",
};

/** The node ids a plan's additions will have on the canvas (a variable or the settings are not nodes). */
export function newNodeIds(diff: AssistantDiffDto): string[] {
  return diff.added.flatMap((a) =>
    a.kind === "step" ? [`workflow:${a.name}`] : a.kind === "tool" ? [`tool:${a.name}`] : [],
  );
}

function changeCount(diff: AssistantDiffDto): number {
  return diff.added.length + diff.changed.length + diff.removed.length;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function DiffRows({ diff }: { diff: AssistantDiffDto }) {
  const rows = [
    ...diff.added.map((i) => ({ ...i, change: "Add" })),
    ...diff.changed.map((i) => ({ ...i, change: "Change" })),
    ...diff.removed.map((i) => ({ ...i, change: "Remove" })),
  ];
  return (
    <ul className="kg-chat__rows" aria-label="What this changes">
      {rows.map((row) => (
        <li key={`${row.change}:${row.kind}:${row.name}`} className="kg-chat__row">
          <span className={`kg-chat__change kg-chat__change--${row.change.toLowerCase()}`}>
            {row.change}
          </span>
          <span className="kg-chat__kind">{KIND_WORD[row.kind] ?? row.kind}</span>
          {row.kind !== "agent" && <span className="kg-chat__name">{row.name}</span>}
        </li>
      ))}
    </ul>
  );
}

export function AssistantPanel({
  api,
  source,
  onChanged,
  onMarkNew,
  onClose,
  hidden = false,
  initialPrompt,
}: AssistantPanelProps) {
  const [status, setStatus] = useState<AssistantStatus | undefined>(undefined);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [showNotice, setShowNotice] = useState(() => !noticed());
  const nextId = useRef(1);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .assistantStatus?.()
      .then((s) => !cancelled && setStatus(s))
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus({
          configured: false,
          error: err instanceof Error ? err.message : "Could not reach the assistant.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!hidden) input.current?.focus();
  }, [hidden]);

  // The newest message comes into view as it arrives.
  useEffect(() => {
    log.current?.scrollTo?.({ top: log.current.scrollHeight });
  }, [messages, busy]);

  const add = (m: NewMessage) =>
    setMessages((prev) => [...prev, { ...m, id: nextId.current++ } as Message]);
  const patch = (id: number, change: Partial<Extract<Message, { kind: "plan" }>>) =>
    setMessages((prev) =>
      prev.map((m) => (m.id === id && m.kind === "plan" ? { ...m, ...change } : m)),
    );

  async function send(event?: FormEvent, override?: string) {
    event?.preventDefault();
    const prompt = (override ?? text).trim();
    if (prompt === "" || busy || !api.askAssistant) return;
    setText("");
    setBusy(true);
    onMarkNew([]);
    add({ kind: "user", text: prompt });
    remember();
    setShowNotice(false);
    try {
      const answer = await api.askAssistant(prompt);
      if (answer.success) {
        add({ kind: "plan", plan: answer, state: "pending" });
      } else {
        add({
          kind: "error",
          text: answer.error,
          ...(answer.errors && answer.errors.length > 0 && { details: answer.errors }),
        });
      }
    } catch (err) {
      add({ kind: "error", text: err instanceof Error ? err.message : "The assistant failed." });
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  }

  async function apply(m: Extract<Message, { kind: "plan" }>) {
    setBusy(true);
    const before = source;
    try {
      const result: ApplyOpsResponse = await api.applyOps(m.plan.ops, {
        baseRevision: m.plan.revision,
      });
      if (!result.success) {
        add({
          kind: "error",
          text: result.stale
            ? "The workflow changed after I made this plan, so I did not apply it. Ask again to plan against the current one."
            : "That plan could not be applied, so nothing changed.",
          details: (result.errors ?? []).map((e) => e.message),
        });
        patch(m.id, { state: "discarded" });
        return;
      }
      patch(m.id, {
        state: "applied",
        before,
        ...(result.revision && { revision: result.revision }),
      });
      onMarkNew(newNodeIds(m.plan.diff));
      await onChanged();
    } catch (err) {
      add({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to apply the plan.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function undo(m: Extract<Message, { kind: "plan" }>) {
    if (m.before === undefined) return;
    setBusy(true);
    try {
      const result = await api.replaceSource(m.before, {
        ...(m.revision !== undefined && { baseRevision: m.revision }),
      });
      if (!result.success) {
        add({
          kind: "error",
          text: result.stale
            ? "The workflow changed after this was applied, so Undo would throw those changes away too. I left it as it is."
            : "Could not undo.",
          details: (result.errors ?? []).map((e) => e.message),
        });
        return;
      }
      patch(m.id, { state: "undone" });
      onMarkNew([]);
      await onChanged();
    } catch (err) {
      add({ kind: "error", text: err instanceof Error ? err.message : "Failed to undo." });
    } finally {
      setBusy(false);
    }
  }

  function discard(m: Extract<Message, { kind: "plan" }>) {
    patch(m.id, { state: "discarded" });
    input.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  const configured = status?.configured === true;

  // The empty state hands over what the person described; it is sent once, as soon as the endpoint is known.
  const sentInitial = useRef(0);
  useEffect(() => {
    if (!initialPrompt || !configured || sentInitial.current === initialPrompt.nonce) return;
    sentInitial.current = initialPrompt.nonce;
    void send(undefined, initialPrompt.text);
  }, [initialPrompt, configured]);

  return (
    <aside
      id="assistant-panel"
      className="md3-palette kg-chat"
      aria-label="Assistant"
      data-testid="assistant-panel"
      hidden={hidden}
    >
      <div className="md3-palette__header">
        <span className="md3-title-small">Assistant</span>
        <button type="button" className="md3-button md3-button-text" onClick={onClose}>
          Steps
        </button>
      </div>

      {status === undefined && (
        <p className="kg-small" role="status">
          Checking the assistant…
        </p>
      )}
      {status && !status.configured && (
        <div className="kg-chat__setup" role="status" data-testid="assistant-setup">
          <p className="kg-small">{status.error}</p>
        </div>
      )}
      {status?.configured && showNotice && (
        <p className="kg-chat__notice kg-small" data-testid="assistant-notice">
          Asking sends your request and this workflow (its text, never your keys) to{" "}
          <strong>{status.host}</strong>, model {status.model}. Nothing changes until you press
          Apply.
        </p>
      )}

      <div
        ref={log}
        className="kg-chat__log"
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        tabIndex={0}
      >
        {messages.length === 0 && configured && (
          <p className="kg-small kg-chat__hint">
            Say what you want in plain words, for example “every weekday morning, fetch the price of
            AAPL and Slack me if it moved more than 5%”. I will show a plan first.
          </p>
        )}
        {messages.map((m) => {
          if (m.kind === "user") {
            return (
              <div key={m.id} className="kg-chat__msg kg-chat__msg--user">
                <span className="md3-visually-hidden">You said: </span>
                {m.text}
              </div>
            );
          }
          if (m.kind === "note") {
            return (
              <p key={m.id} className="kg-small">
                {m.text}
              </p>
            );
          }
          if (m.kind === "error") {
            return (
              <div key={m.id} className="kg-chat__msg kg-chat__msg--error" role="alert">
                <p>{m.text}</p>
                {m.details && (
                  <ul>
                    {m.details.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          }
          const n = changeCount(m.plan.diff);
          return (
            <section
              key={m.id}
              className="kg-chat__msg kg-chat__plan"
              aria-label="Proposed plan"
              data-state={m.state}
            >
              <p>{m.plan.summary}</p>
              <p className="kg-chat__plan-count">Plan · {plural(n, "change")}</p>
              <DiffRows diff={m.plan.diff} />
              {m.state === "pending" && (
                <div className="kg-chat__actions">
                  <button
                    type="button"
                    className="md3-button md3-button-filled"
                    disabled={busy}
                    onClick={() => void apply(m)}
                  >
                    Apply to canvas
                  </button>
                  <button
                    type="button"
                    className="md3-button md3-button-text"
                    disabled={busy}
                    onClick={() => discard(m)}
                  >
                    Discard
                  </button>
                </div>
              )}
              {m.state === "applied" && (
                <div className="kg-chat__actions" role="status">
                  <span>Applied: {plural(n, "change")}.</span>
                  <button
                    type="button"
                    className="md3-button md3-button-tonal"
                    disabled={busy}
                    onClick={() => void undo(m)}
                  >
                    Undo
                  </button>
                </div>
              )}
              {m.state === "undone" && <p role="status">Undone. The workflow is as it was.</p>}
              {m.state === "discarded" && <p role="status">Not applied.</p>}
            </section>
          );
        })}
        {busy && (
          <p className="kg-small kg-chat__busy" role="status">
            Working…
          </p>
        )}
      </div>

      <form className="kg-chat__form" onSubmit={(e) => void send(e)}>
        <label className="md3-label-large" htmlFor="assistant-input">
          Describe a change
        </label>
        <textarea
          id="assistant-input"
          ref={input}
          className="md3-text-field kg-chat__input"
          rows={3}
          value={text}
          disabled={!configured}
          placeholder={configured ? "What should it do?" : "Set up the assistant first"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="kg-chat__send">
          <span className="kg-small">Enter sends, Shift+Enter adds a line</span>
          <button
            type="submit"
            className="md3-button md3-button-filled"
            disabled={!configured || busy || text.trim() === ""}
          >
            Send
          </button>
        </div>
      </form>
    </aside>
  );
}
