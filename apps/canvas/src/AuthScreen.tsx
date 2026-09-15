import { useState } from "react";
import type { HostedClient } from "./api.js";

// KAN-1228 (ADR-0019/ADR-0020): the sign-in / sign-up gate for hosted mode.
// Email+password against Better Auth's own endpoints (packages/server
// mounts them at /api/auth/*), plus an optional GitHub button that only does
// anything if the server has GitHub OAuth configured. On success the parent
// (HostedApp) re-reads the session and moves on to workspace selection.

export interface AuthScreenProps {
  api: HostedClient;
  onAuthenticated: () => void;
}

type Mode = "signIn" | "signUp";

export function AuthScreen({ api, onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>("signIn");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "signUp") {
        await api.signUp({ name: name || email, email, password });
      } else {
        await api.signIn({ email, password });
      }
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGithub() {
    setError(null);
    try {
      await api.signInWithGithub(window.location.origin);
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub sign-in is unavailable.");
    }
  }

  return (
    <div className="md3-centered-screen">
      <div className="md3-elevated-surface md3-stack" data-testid="auth-screen">
        <h1 className="md3-title-large">Kampong Agents</h1>
        <p className="md3-body-medium">
          {mode === "signIn" ? "Sign in to your workspace." : "Create an account to get started."}
        </p>

        <form className="md3-form" onSubmit={(e) => void handleSubmit(e)}>
          {mode === "signUp" && (
            <label className="md3-field">
              <span className="md3-field__label md3-label-large">Name</span>
              <input
                className="md3-text-field"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Email</span>
            <input
              className="md3-text-field"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Password</span>
            <input
              className="md3-text-field"
              type="password"
              autoComplete={mode === "signIn" ? "current-password" : "new-password"}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && (
            <div role="alert" data-testid="auth-error" className="md3-banner md3-banner--error">
              {error}
            </div>
          )}

          <button type="submit" className="md3-button md3-button-filled" disabled={busy}>
            {mode === "signIn" ? "Sign in" : "Sign up"}
          </button>
        </form>

        <button
          type="button"
          className="md3-button md3-button-outlined md3-button-outlined--neutral"
          onClick={() => void handleGithub()}
        >
          Continue with GitHub
        </button>

        <button
          type="button"
          className="md3-button md3-button-text"
          data-testid="auth-toggle"
          onClick={() => {
            setMode(mode === "signIn" ? "signUp" : "signIn");
            setError(null);
          }}
        >
          {mode === "signIn" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
