import { useEffect, useState } from "react";
import type { HostedClient, Workspace } from "./api.js";

// KAN-1228 (ADR-0019/ADR-0020): workspace selection, shown after sign-in when
// the session has no active workspace (or when the user asks to switch). A
// hosted request is 403 without an active workspace (resolveWorkspaceContext),
// so this is the gate between signing in and doing anything. Lets the user
// pick an existing workspace or create one; either way it calls
// `setActiveWorkspace` (Better Auth's organization/set-active), which is what
// stamps `session.activeOrganizationId`.

export interface WorkspaceScreenProps {
  api: HostedClient;
  onActive: () => void;
}

export function WorkspaceScreen({ api, onActive }: WorkspaceScreenProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setWorkspaces(await api.listWorkspaces());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load workspaces.");
        setWorkspaces([]);
      }
    })();
  }, [api]);

  // KNOWN LIMITATION (tracked as a follow-up card): switching to an *existing*
  // workspace calls Better Auth's organization/set-active, whose checkMembership
  // reads workspace_members through an unscoped connection that FORCE RLS blocks
  // (no app.workspace_id GUC), so it fails with "not a member" even for a real
  // member. Creating a workspace works (organization/create sets it active
  // itself). A proper fix is an app-authored, workspace-scoped activate route
  // (the same KAN-1393 area as retiring the 0004/0005 bootstrap pair). Until
  // then the error is surfaced honestly rather than hidden.
  async function activate(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.setActiveWorkspace(id);
      onActive();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch workspace.");
      setBusy(false);
    }
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (busy || newName.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Better Auth's organization/create stamps the new workspace active on
      // the session itself (it's how the server's integration tests get a
      // workspace-scoped cookie). Deliberately NOT followed by set-active: that
      // endpoint's checkMembership reads workspace_members through an unscoped
      // connection, which FORCE RLS (no app.workspace_id GUC) blocks with
      // "not a member" -- see the note on `activate` below.
      await api.createWorkspace(newName.trim());
      onActive();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the workspace.");
      setBusy(false);
    }
  }

  return (
    <div className="md3-centered-screen">
      <div className="md3-elevated-surface md3-stack" data-testid="workspace-screen">
        <h1 className="md3-title-large">Choose a workspace</h1>

        {workspaces === null ? (
          <p className="md3-body-medium">Loading…</p>
        ) : workspaces.length > 0 ? (
          <ul className="md3-list" data-testid="workspace-list">
            {workspaces.map((ws) => (
              <li key={ws.id}>
                <button
                  className="md3-list-item"
                  disabled={busy}
                  onClick={() => void activate(ws.id)}
                >
                  <span className="md3-list-item__title">{ws.name}</span>
                  <span className="md3-list-item__meta">{ws.slug}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="md3-body-medium">
            You don't have a workspace yet. Create one to start building agents.
          </p>
        )}

        <form className="md3-form" onSubmit={(e) => void handleCreate(e)}>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">New workspace name</span>
            <input
              className="md3-text-field"
              value={newName}
              placeholder="e.g. Acme AI"
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
          {error && (
            <div
              role="alert"
              data-testid="workspace-error"
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
            Create workspace
          </button>
        </form>
      </div>
    </div>
  );
}
