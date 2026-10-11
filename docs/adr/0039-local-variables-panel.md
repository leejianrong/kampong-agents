# ADR-0039: A write-only Variables panel for local secrets

Status: accepted

## Context

A spec holds `${NAME}` and never a value (ADR-0009), and the values lived only in `.env` or the shell. To try
a spec an author had to leave the canvas, edit a file, and restart the server, and the first-party Slack
component's token never appears as `${NAME}` in the spec at all, so nothing in the canvas said it was needed.
Teams know the CI pattern of a settings page where a value is set once and can never be read back.

## Decision

- `kampong dev` serves `GET /api/secrets`, `PUT /api/secrets/:name` and `DELETE /api/secrets/:name`. No route
  returns a value. A response carries each name, whether it is `saved`, `environment` or `unset`, and whether
  the open spec needs it.
- Names come from `${NAME}` references in the spec and from the names the offline doctor checks resolve,
  which covers a component's credential slot and any `secrets` remap.
- Values live in `<.kampong>/secrets.env`, one `NAME=<JSON string>` per line (never parsed as shell), mode
  0600, with a `.kampong/.gitignore` for that one file beside it. They are applied to the server's own
  environment, which runs, checks and components already read, so a change needs no restart.
- A saved value overrides the environment; removing it restores what the environment held.
- The existing Host and same-origin checks on `/api/*` guard these routes.

## Consequences

- The canvas shows a name and a state, never a secret, so the panel cannot leak what it holds.
- The file is plaintext on disk like `.env`. It is for local use, and is not encryption. The hosted slice
  (V5) has its own secret store and does not use this.
- `kampong run` and `kampong serve` do not read this file; they still read the process environment.
