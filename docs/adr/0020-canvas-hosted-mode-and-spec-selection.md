# ADR-0020: Canvas hosted mode and spec selection

- Status: Accepted
- Date: 2026-09-15
- Deciders: Jian (product owner)

## Context

Through V1–V4 the canvas (`apps/canvas`) only ever talked to the local server
`kampong dev` starts (`packages/cli`): one implicit spec at `/api/spec`, no
authentication, a file-watcher SSE stream, and single-process runs (ADR-0005,
ADR-0007). V5 built the entire hosted backend (`packages/server`, PRs #40–#45):
Better Auth sessions at `/api/auth/*`, workspace-scoped multi-spec CRUD at
`/api/specs/:id` under Postgres RLS (ADR-0019), masked BYOK key management at
`/api/byok` (ADR-0016), and durable server-side runs. But the canvas still spoke
only the local single-spec API and had no auth, so the hosted flow was not
usable in a browser. KAN-1228 (SLICES.md V5, build-plan step 8) closes that gap.

Two things had to be decided to do it without forking the app.

## Decision

### 1. One bundle, two modes, chosen behind the `createApiClient` seam

The same built canvas is served from one origin by both servers (ADR-0005's
reusable web app, carried to hosted by ADR-0013). Rather than build or ship two
apps, the bundle **probes which server is answering at startup**
(`detectServerMode`, `apps/canvas/src/api.ts`): it requests
`GET /api/auth/get-session`, which the hosted server answers 2xx (body `null`
when signed out) and the local server — having no such route — 404s. Any network
failure falls back to `local`, the mode that needs no hosted infrastructure.
`main.tsx` then mounts the local single-spec `App` or the auth-gated `HostedApp`.

The editor itself (`App`, `RunPanel`, the forms) is **unchanged between modes**.
Both a local client and each hosted per-spec client implement one `ApiClient`
interface (`api.ts`); hosted mode passes `App` a client bound to the chosen spec
(`HostedClient.specClient(id)`), which addresses `/api/specs/:id`, starts runs at
`/api/specs/:id/runs`, and makes `subscribeToEvents` a no-op (hosted specs live
in Postgres, not on disk, so there is no file watcher). This is the payoff of the
`createApiClient(baseUrl)` seam the earlier slices deliberately left in place:
the mode difference lives entirely in which `ApiClient` is constructed, never in
the editor UI.

### 2. Hosted mode lands on an explicit spec-list view, not an implicit "current" spec

The local canvas edits one implicit spec because `kampong dev` is a
one-spec-per-process tool (ADR-0011). A hosted workspace holds many specs
(`/api/specs` is a collection, ADR-0019), so hosted mode needs a "which spec?"
step the local canvas never had. The decision is an **explicit spec-list landing
view** (`SpecList.tsx`): after auth and workspace selection, the user always
lands on a list of the workspace's specs (`GET /api/specs`) plus a "new agent"
action (`POST /api/specs` from a minimal starter template), and picking one
routes the editor at that spec's id.

The rejected alternative was auto-opening some server-designated "current"/most-
recent spec and hiding the list behind a switcher. That was rejected because a
new or empty workspace has no current spec (so the empty state would be a dead
end, which is exactly the "didn't know what to do" problem the product is trying
to fix), and because "which spec am I editing?" being implicit is precisely the
ambiguity multi-spec introduces — making it explicit is the honest design.

### 3. Auth progression and the 401 gate

`HostedApp` is a small explicit state machine (no router dependency for four
views): `loading → auth → workspace → home{ specs | editor | byok }`. It reads
the session once (`getSession`) and routes on it — no session → login/sign-up
(`AuthScreen`, email+password and an optional GitHub button); a session with no
`activeOrganizationId` → workspace create/select (`WorkspaceScreen`, which calls
Better Auth's `organization/create` + `organization/set-active`, the same path
KAN-1226/ADR-0019 rely on); otherwise the workspace home.

Because RLS returns 401 for an expired or revoked session on any route, the
hosted client is wrapped once (`guardUnauthorized`) so a 401 from anywhere —
control-plane call or the editor's own `loadSpec`/`applyPatch` — drops the shell
back to the login screen rather than surfacing a dead-end error. `getSession` and
the sign-in/out methods are passed through unwrapped (getSession returns `null`,
never throws, when signed out; the auth methods are how a session is obtained).

### 4. BYOK key management is write-only in the UI (ADR-0016 made concrete)

The BYOK screen (`ByokScreen.tsx`) is the UI half deferred from KAN-1229. It
adds/replaces (`PUT /api/byok/:provider`), lists (`GET /api/byok`), and deletes
keys, but a key value is **write-only**: once submitted it is shown only as its
masked last four characters (`····ab12`), because the server never returns a
decrypted or encrypted key (ADR-0016). A run finds the key by matching the
provider named in the spec's `model` block to a stored key
(`resolveWorkspaceModelClient`), which is why the "new agent" starter template
includes a `model` block with a placeholder `api_key` (present only to satisfy
validation — the stored BYOK key is substituted at run time).

## Consequences

- The hosted demo is clickable end to end in a browser: sign up → create a
  workspace → add a BYOK key → create/edit a spec on the canvas → run it →
  approve a guardrail pause → see the trace, all against `packages/server`.
- `kampong dev` is untouched: the local single-spec flow, its file-watcher
  auto-reload (ADR-0008), and every existing App/api test still pass unchanged.
- Full end-to-end verification in a real browser (against a real Postgres) is a
  separate concern — a Playwright browser layer is its own follow-up, tracked
  apart from this UI slice.
- Mode detection is a runtime probe, not a build flag, specifically so one
  artifact serves both servers. If a future deployment ever serves the canvas
  from an origin without the API, the probe fails closed to local; that is
  acceptable because no such deployment exists (both servers serve the bundle
  and the API from one origin, ADR-0005/ADR-0013).
