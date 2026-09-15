import { useCallback, useEffect, useState } from "react";
import { starterSpec, type HostedClient, type SpecSummary } from "./api.js";

// KAN-1228 (ADR-0020): the hosted spec-list landing view -- the explicit
// "which spec?" step the local single-spec canvas never needed. Lists the
// workspace's specs (GET /api/specs) and creates a new one from a minimal
// starter template (POST /api/specs). Picking or creating a spec routes the
// editor at `/api/specs/:id`. This is the design fork ADR-0020 records: rather
// than auto-opening some "current" spec, hosted mode always lands here so the
// user chooses, and a new/empty workspace has an obvious first action.

export interface SpecListProps {
  api: HostedClient;
  onOpen: (spec: SpecSummary) => void;
}

export function SpecList({ api, onOpen }: SpecListProps) {
  const [specs, setSpecs] = useState<SpecSummary[] | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSpecs(await api.listSpecs());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load specs.");
      setSpecs([]);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (busy || name.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createSpec(name, starterSpec(name));
      onOpen({ id: created.id, name: created.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the spec.");
      setBusy(false);
    }
  }

  return (
    <div className="md3-page">
      <div className="md3-page__content md3-stack" data-testid="spec-list">
        <h1 className="md3-title-large">Your agents</h1>

        {specs === null ? (
          <p className="md3-body-medium">Loading…</p>
        ) : specs.length > 0 ? (
          <ul className="md3-grid" data-testid="spec-grid">
            {specs.map((spec) => (
              <li key={spec.id}>
                <button className="md3-spec-card" onClick={() => onOpen(spec)}>
                  <span className="md3-title-medium">{spec.name}</span>
                  <span className="md3-body-medium">Open in canvas →</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="md3-stack" data-testid="spec-list-empty">
            <p className="md3-body-medium">No agents yet. Create your first one below.</p>
            <p className="md3-body-medium">
              Tip: add a model provider key under <strong>Manage keys</strong> (top right) so your
              agent can run — the key’s provider must match the one in the agent’s spec.
            </p>
          </div>
        )}

        <form className="md3-form" onSubmit={(e) => void handleCreate(e)}>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">New agent name</span>
            <input
              className="md3-text-field"
              value={newName}
              placeholder="e.g. Support Triage"
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
          {error && (
            <div
              role="alert"
              data-testid="spec-list-error"
              className="md3-banner md3-banner--error"
            >
              {error}
            </div>
          )}
          <button
            type="submit"
            className="md3-button md3-button-filled"
            disabled={busy || newName.trim().length === 0}
          >
            Create agent
          </button>
        </form>
      </div>
    </div>
  );
}
