import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { HostedApp } from "./HostedApp.js";
import { detectServerMode } from "./api.js";
import "./theme.css";

// KAN-1228 (ADR-0020): the same built bundle is served by both the local
// `kampong dev` server and the hosted multi-tenant server, so it probes which
// one is answering at startup and mounts the matching root -- the local
// single-spec `App` or the auth-gated `HostedApp`. Any probe failure falls
// back to local, the mode that needs no hosted infrastructure.

function Root() {
  const [mode, setMode] = useState<"loading" | "local" | "hosted">("loading");

  useEffect(() => {
    void detectServerMode().then(setMode);
  }, []);

  if (mode === "loading") {
    return (
      <div className="md3-centered-screen">
        <p className="md3-body-medium">Loading…</p>
      </div>
    );
  }
  return mode === "hosted" ? <HostedApp /> : <App />;
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
