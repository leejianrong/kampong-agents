# ADR-0030: First-party components and how the legacy tool kinds run on them

- Status: Accepted
- Date: 2026-10-06
- Deciders: Jian (product owner)

## Context

ADR-0025 said components live in a `components/` directory in this repository, and ADR-0029 said the
legacy `slack_post_message` and `gmail_send` kinds are desugared to component calls and stay valid.
Building it (KAN-1886) needed four choices the earlier ADRs left open.

## Decision

1. **First-party components ship inside the engine package**, at `packages/engine/components/`, not at
   the repository root. They must travel with the code that runs them: a root folder would not be in
   an installed `@kampong/engine`. The layout is the one ADR-0025 and KAN-1834 fixed
   (`<namespace>/<name>/<version>/component.yaml`), and the `kampong/*` namespace is served only from
   here. `LayeredComponentRegistry` answers `kampong/*` from the first-party registry alone and
   everything else from the project's folder, so a project cannot shadow or impersonate a first-party
   component.
2. **First-party components need no lockfile pin.** They are versioned with the package that ships
   them. A spec may still pin one with `kampong lock`, and a pin that exists is enforced. Every other
   component still needs a pin when `requirePins` is on.
3. **Slack is a `kind: rest` manifest; Gmail is a `kind: module`.** The Gmail API takes the whole
   message as base64url MIME, which a request template cannot build. The module sees only its `ctx`
   and may reach only `gmail.googleapis.com`.
4. **Legacy tools run as components only when a component dispatcher is configured.** `desugarLegacyTool`
   maps the two kinds to `kampong/slack@1.0.0` / `kampong/gmail@1.0.0` calls, keeping name, token,
   `requires_approval` and `extract`. A bare engine, or an export that has not vendored the
   interpreter, takes the original request builders. The two paths produce byte-identical requests
   (tested against the legacy builders), so recorded fixtures keep matching.

## Behaviour changes, deliberately

- **Slack `{"ok": false}` is a failure.** Slack answers most errors with HTTP 200, and the legacy path
  reported them as success. `kampong/slack` declares a `failure_when` rule, so the step now fails with
  Slack's error code. A flow that relied on ignoring a Slack error will now stop.
- **Gmail refuses a line break in `to` or `subject`.** Those values are written into MIME header lines,
  so a line break in a step output could add headers such as `Bcc`. The legacy builder had this flaw.

## Consequences

- The two legacy builders in `http-tool.ts` stay until every runtime that executes specs has
  components available; removing them is a later cleanup.
- The canvas Component kind lists the first-party components next to the project's own.
- The exporter vendors the interpreter and the components a spec uses (next change), so exports run the
  same code paths.
