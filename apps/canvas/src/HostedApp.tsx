import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "./App.js";
import { AuthScreen } from "./AuthScreen.js";
import { ByokScreen } from "./ByokScreen.js";
import { SpecList } from "./SpecList.js";
import { WorkspaceScreen } from "./WorkspaceScreen.js";
import {
  createHostedClient,
  guardUnauthorized,
  type SessionInfo,
  type SpecSummary,
} from "./api.js";

// KAN-1228 (ADR-0019/ADR-0020): the hosted-mode shell. Owns the auth →
// workspace → spec-list → editor progression the local single-spec canvas
// never needed, and reuses the exact same `App` editor for one chosen spec
// (bound to a per-spec `ApiClient`). `main.tsx` renders this only when it has
// probed the server as hosted; local `kampong dev` renders `App` directly.
//
// State machine (deliberately explicit, no router dependency for four views):
//   loading  -> (getSession)
//   auth      -> no session
//   workspace -> session but no active workspace (or "switch workspace")
//   home      -> { specs | editor | byok }

export interface HostedAppProps {
  apiBaseUrl?: string;
}

type Phase = "loading" | "auth" | "workspace" | "home";
type HomeView = "specs" | "editor" | "byok";

export function HostedApp({ apiBaseUrl = "" }: HostedAppProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [view, setView] = useState<HomeView>("specs");
  const [openSpec, setOpenSpec] = useState<SpecSummary | null>(null);

  const toAuth = useCallback(() => {
    setSession(null);
    setOpenSpec(null);
    setView("specs");
    setPhase("auth");
  }, []);

  // The one client instance, wrapped so any 401 anywhere drops back to login.
  const api = useMemo(
    () => guardUnauthorized(createHostedClient(apiBaseUrl), toAuth),
    [apiBaseUrl, toAuth],
  );

  const refreshSession = useCallback(async () => {
    const s = await api.getSession();
    setSession(s);
    if (!s) {
      setPhase("auth");
    } else if (!s.session.activeOrganizationId) {
      setPhase("workspace");
    } else {
      setPhase("home");
    }
  }, [api]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  async function handleSignOut() {
    try {
      await api.signOut();
    } finally {
      toAuth();
    }
  }

  if (phase === "loading") {
    return (
      <div className="md3-centered-screen">
        <p className="md3-body-medium">Loading…</p>
      </div>
    );
  }

  if (phase === "auth") {
    return <AuthScreen api={api} onAuthenticated={() => void refreshSession()} />;
  }

  if (phase === "workspace") {
    return <WorkspaceScreen api={api} onActive={() => void refreshSession()} />;
  }

  // phase === "home"
  const topBar = (
    <div className="md3-topbar" data-testid="hosted-topbar">
      <span className="md3-title-medium md3-topbar__brand">Kampong Agents</span>
      <span className="md3-topbar__spacer" />
      <span className="md3-body-medium" data-testid="hosted-user">
        {session?.user.email}
      </span>
      <button
        className="md3-button md3-button-text"
        onClick={() => setView("byok")}
        data-testid="nav-byok"
      >
        Manage keys
      </button>
      <button
        className="md3-button md3-button-text"
        onClick={() => void handleSignOut()}
        data-testid="nav-signout"
      >
        Sign out
      </button>
    </div>
  );

  if (view === "editor" && openSpec) {
    return (
      <div className="md3-hosted-shell">
        {topBar}
        <div className="md3-hosted-shell__body">
          <App
            api={api.specClient(openSpec.id)}
            specName={openSpec.name}
            onNavigateBack={() => setView("specs")}
            onUnauthorized={toAuth}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="md3-hosted-shell">
      {topBar}
      <div className="md3-hosted-shell__body">
        {view === "byok" ? (
          <ByokScreen api={api} onBack={() => setView("specs")} />
        ) : (
          <SpecList
            api={api}
            onOpen={(spec) => {
              setOpenSpec(spec);
              setView("editor");
            }}
          />
        )}
      </div>
    </div>
  );
}
