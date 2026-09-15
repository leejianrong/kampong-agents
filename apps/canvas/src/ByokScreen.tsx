import { useCallback, useEffect, useState } from "react";
import type { ByokKeyInfo, HostedClient } from "./api.js";

// KAN-1228 / KAN-1229 (ADR-0016): the workspace BYOK key-management screen --
// the UI half deferred from KAN-1229 until the canvas had auth. Add or replace
// a provider's key, list which providers are configured (masked to the last
// four characters -- the server NEVER returns a decrypted key, ADR-0016), and
// delete one. The raw key value is write-only: once submitted it's shown only
// as `····last4`. This is what makes a hosted run able to find a key by the
// provider named in the spec's `model` block (resolveWorkspaceModelClient).

export interface ByokScreenProps {
  api: HostedClient;
  onBack: () => void;
}

// A small, curated provider list keeps the common case one click, while "other"
// lets the user type any slug the engine supports.
const KNOWN_PROVIDERS = ["openai", "anthropic", "openrouter", "google", "mistral"];

export function ByokScreen({ api, onBack }: ByokScreenProps) {
  const [keys, setKeys] = useState<ByokKeyInfo[] | null>(null);
  const [provider, setProvider] = useState("openai");
  const [customProvider, setCustomProvider] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setKeys(await api.listByokKeys());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load keys.");
      setKeys([]);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolvedProvider = provider === "other" ? customProvider.trim().toLowerCase() : provider;

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (busy || value.length === 0 || resolvedProvider.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.putByokKey(resolvedProvider, value);
      setValue("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the key.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(p: string) {
    setBusy(true);
    setError(null);
    try {
      await api.deleteByokKey(p);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete the key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="md3-page">
      <div className="md3-page__content md3-stack" data-testid="byok-screen">
        <div className="md3-page__header">
          <button className="md3-button md3-button-text" onClick={onBack} data-testid="byok-back">
            ← Back
          </button>
          <h1 className="md3-title-large">Model provider keys</h1>
        </div>

        <p className="md3-body-medium">
          Keys are encrypted at rest and never shown again after saving — only the last four
          characters are displayed. A run uses the key whose provider matches the spec's model.
        </p>

        {keys === null ? (
          <p className="md3-body-medium">Loading…</p>
        ) : keys.length > 0 ? (
          <ul className="md3-list" data-testid="byok-list">
            {keys.map((k) => (
              <li key={k.provider} className="md3-list-row">
                <span className="md3-list-item__title">{k.provider}</span>
                <span className="md3-key-mask">····{k.lastFour}</span>
                <button
                  className="md3-button md3-button-outlined"
                  disabled={busy}
                  onClick={() => void handleDelete(k.provider)}
                  data-testid={`byok-delete-${k.provider}`}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="md3-body-medium" data-testid="byok-empty">
            No keys configured yet.
          </p>
        )}

        <form className="md3-form" onSubmit={(e) => void handleSave(e)}>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Provider</span>
            <select
              className="md3-text-field"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              {KNOWN_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
              <option value="other">Other…</option>
            </select>
          </label>
          {provider === "other" && (
            <label className="md3-field">
              <span className="md3-field__label md3-label-large">Provider slug</span>
              <input
                className="md3-text-field"
                value={customProvider}
                placeholder="e.g. together"
                onChange={(e) => setCustomProvider(e.target.value)}
              />
            </label>
          )}
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">API key</span>
            <input
              className="md3-text-field"
              type="password"
              autoComplete="off"
              value={value}
              placeholder="sk-…"
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          {error && (
            <div role="alert" data-testid="byok-error" className="md3-banner md3-banner--error">
              {error}
            </div>
          )}
          <button
            type="submit"
            className="md3-button md3-button-filled"
            disabled={busy || value.length === 0 || resolvedProvider.length === 0}
          >
            Save key
          </button>
        </form>
      </div>
    </div>
  );
}
