import { useEffect, useState } from "react";
import type { SecretStatusDto } from "./api.js";

// Variables: set a credential once, by name, the way a CI settings page does. It is write-only. The
// server never sends a value back, so this panel has nothing to show, copy or leak: only the name, where
// it comes from, and a field to set or replace it. A spec holds `${NAME}` and nothing else.

export interface SecretsPanelProps {
  list: () => Promise<SecretStatusDto[]>;
  save: (name: string, value: string) => Promise<SecretStatusDto[]>;
  remove: (name: string) => Promise<SecretStatusDto[]>;
}

const SOURCE = {
  saved: "Saved here",
  environment: "From the environment",
  unset: "Not set",
} as const;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function SecretsPanel({ list, save, remove }: SecretsPanelProps) {
  const [rows, setRows] = useState<SecretStatusDto[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    list().then(
      (found) => live && setRows(found),
      (err: unknown) => live && setError(messageOf(err, "Could not load the variables.")),
    );
    return () => {
      live = false;
    };
  }, [list]);

  async function change(action: () => Promise<SecretStatusDto[]>, done?: () => void) {
    setBusy(true);
    setError(null);
    try {
      setRows(await action());
      done?.();
    } catch (err) {
      setError(messageOf(err, "That did not work."));
    } finally {
      setBusy(false);
    }
  }

  const finishEditing = () => {
    setEditing(null);
    setNewName("");
    setValue("");
  };

  const adding = editing === "";
  const target = adding ? newName.trim() : (editing ?? "");
  const canSave = !busy && NAME.test(target) && value !== "";

  return (
    <section className="md3-doctor" aria-label="Variables" data-testid="secrets-panel">
      <div className="md3-doctor__head">
        <span className="md3-title-medium">Variables</span>
        <button
          type="button"
          className="md3-button md3-button-tonal"
          disabled={busy || editing !== null}
          onClick={() => setEditing("")}
        >
          Add variable
        </button>
      </div>
      <p className="md3-body-small md3-field__hint">
        Values are stored on this machine in <code>.kampong/secrets.env</code>, outside your spec.
        They can be set and replaced but never shown again.
      </p>

      {error && (
        <p role="alert" className="md3-banner md3-banner--error">
          {error}
        </p>
      )}

      {editing !== null && (
        <form
          className="md3-secrets__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) void change(() => save(target, value), finishEditing);
          }}
        >
          {adding && (
            <label className="md3-field">
              <span className="md3-body-small md3-field__label">Name</span>
              <input
                className="md3-text-field"
                value={newName}
                placeholder="SLACK_BOT_TOKEN"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
              />
            </label>
          )}
          <label className="md3-field">
            <span className="md3-body-small md3-field__label">
              {adding ? "Value" : `New value for ${editing}`}
            </span>
            <input
              className="md3-text-field"
              type="password"
              value={value}
              autoComplete="new-password"
              spellCheck={false}
              autoFocus={!adding}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <div className="md3-trust__actions">
            <button type="submit" className="md3-button md3-button-filled" disabled={!canSave}>
              Save
            </button>
            <button type="button" className="md3-button md3-button-text" onClick={finishEditing}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {rows && rows.length === 0 && (
        <p className="md3-body-medium">
          This spec reads no variables yet. A reference such as <code>{"${SLACK_BOT_TOKEN}"}</code>{" "}
          in the spec will show up here.
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul className="md3-doctor__list" data-testid="secrets-list">
          {rows.map((row) => (
            <li key={row.name} className="md3-secrets__row">
              <span className="md3-body-medium md3-secrets__name">{row.name}</span>
              <span className={`md3-status-chip md3-status-chip--${chip(row)}`}>
                {row.source === "unset" && row.referenced ? "Needed, not set" : SOURCE[row.source]}
              </span>
              <span className="md3-secrets__actions">
                <button
                  type="button"
                  className="md3-button md3-button-text"
                  disabled={busy || editing !== null}
                  aria-label={`${row.source === "saved" ? "Replace" : "Set"} ${row.name}`}
                  onClick={() => setEditing(row.name)}
                >
                  {row.source === "saved" ? "Replace" : "Set"}
                </button>
                {row.source === "saved" && (
                  <button
                    type="button"
                    className="md3-button md3-button-text"
                    disabled={busy}
                    aria-label={`Remove ${row.name}`}
                    onClick={() => void change(() => remove(row.name))}
                  >
                    Remove
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function chip(row: SecretStatusDto): string {
  if (row.source === "unset") return row.referenced ? "unpinned" : "changed";
  return "pinned";
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
