# ADR-0005: Canvas ships as a local web app served by the CLI, not a desktop app

- Status: Accepted
- Date: 2026-09-03
- Deciders: Jian (product owner)

## Context

The ideation doc's deployment-spectrum section (§5.1) frames "local sandbox" as a "desktop engine," suggesting an Electron/Tauri-style desktop app. But the long-term plan explicitly includes a hosted/BYOK SaaS mode (roadmap V5) and eventually enterprise deployment (roadmap V6) using the same product. Building a desktop app for local mode and a separate web app for hosted mode would mean maintaining two UI codebases with two different packaging/distribution pipelines, doubling UI engineering effort for no product benefit.

## Decision

The canvas is a web application. Locally, the CLI (`kampong dev`) starts a Node server that serves this same web UI on `localhost` and reads/writes files in the current project directory. In hosted mode (V5), the identical UI is served multi-tenant from the cloud, talking to a backend instead of the local filesystem. There is no separate desktop app.

## Alternatives considered

| Option                                                | Why not                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron/Tauri desktop app                            | Real desktop integration (native file dialogs, OS keychain access) is nice, but doubles UI engineering effort against a hosted web version that's already on the roadmap, and adds a packaging/code-signing/auto-update burden that a `localhost`-served web app avoids entirely. |
| Web app only, no local mode (cloud-only from day one) | Contradicts the "local-first dev experience" engineering priority (BUILD APPROACH) and the trust story ("test fully offline, no data leaves your machine") that differentiates this from most competitors.                                                                        |

## Consequences

- One UI codebase serves both local and hosted modes; local-mode-specific code (filesystem access, file-watching) is isolated behind an interface the hosted backend implements differently later.
- OS keychain access for secrets (Q14) is not available the way a native app would get it for free; v1 relies on `.env` files, which is a reasonable but slightly less secure default for local secret storage — acceptable for a single-developer local tool, worth revisiting if enterprise customers require stricter local secret handling.
- No app-store distribution or auto-update mechanism is needed; distribution is via `npm`/`npx`, consistent with the developer-tool positioning.
