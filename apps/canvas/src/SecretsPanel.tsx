import { PanelError, PanelFooter } from "./Panel";
import { useEffect, useState } from "react";
import type { SecretStatusDto } from "./api.js";

// Secrets: set a credential once, by name, the way a CI settings page does. It is write-only. The
// server never sends a value back, so this panel has nothing to show, copy or leak: only the name, where
// it comes from, and a field to set or replace it. A spec holds `${NAME}` and nothing else.

export interface SecretsPanelProps {
  list: () => Promise<SecretStatusDto[]>;
  save: (name: string, value: string) => Promise<SecretStatusDto[]>;
  remove: (name: string) => Promise<SecretStatusDto[]>;
  /**
   * KAM-192: asks the panel to open its Set form for this name, as the Test Run and Checks "Set it here" buttons
   * do. A new `nonce` asks again, so the same name can be asked for twice.
   */
  focus?: { name: string; nonce: number };
}

const SOURCE = {
  saved: "Saved here",
  environment: "From the environment",
  unset: "Not set",
} as const;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function SecretsPanel({ list, save, remove, focus }: SecretsPanelProps) {
  const [rows, setRows] = useState<SecretStatusDto[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // KAM-192: open the Set form for the name a "Set it here" button asked for, with nothing typed yet.
  const focusName = focus?.name;
  const focusNonce = focus?.nonce;
  useEffect(() => {
    if (focusName === undefined || !NAME.test(focusName)) return;
    setEditing(focusName);
    setNewName("");
    setValue("");
    setError(null);
  }, [focusName, focusNonce]);

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
  // KAM-197: Save is disabled until there is something it can save; say what is missing.
  const saveBlockedBecause = busy
    ? "Saving, one moment."
    : target === ""
      ? "Enter a name to save."
      : !NAME.test(target)
        ? "A name uses letters, digits and underscores, and starts with a letter or an underscore."
        : value === ""
          ? "Enter a value to save."
          : undefined;

  return (
    <div className="md3-doctor" data-testid="secrets-panel">
      <div className="md3-doctor__head">
        <button
          type="button"
          className="md3-button md3-button-tonal"
          disabled={busy || editing !== null}
          onClick={() => setEditing("")}
        >
          Add secret
        </button>
      </div>
      <p className="md3-body-small md3-field__hint">
        Values are stored on this machine in <code>.kampong/secrets.env</code>, outside your spec.
        They can be set and replaced but never shown again.
      </p>

      {error && <PanelError messages={[error]} />}

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
          <PanelFooter
            save="Save"
            disabled={!canSave}
            {...(saveBlockedBecause && { disabledReason: saveBlockedBecause })}
            onCancel={finishEditing}
          />
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
    </div>
  );
}

function chip(row: SecretStatusDto): string {
  if (row.source === "unset") return row.referenced ? "unpinned" : "changed";
  return "pinned";
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
