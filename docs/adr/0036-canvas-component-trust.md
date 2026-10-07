# ADR-0036: The canvas shows component trust and can pin and check

Date: 2026-10-07. Status: accepted. Card: KAN-1901. Builds on ADR-0031 (permissions), ADR-0032 (doctor).

## Context

Pinning (`kampong lock`) and preflight (`kampong doctor`) existed only in the CLI. A canvas user could add a
component tool, save it, and only find out at run time that it was unpinned, with no view of what the
component may do.

## Decision

- **No new logic in the canvas.** The server computes everything and the canvas renders it, so the review
  rules live in one place with the CLI's.
- `GET /api/components` entries now carry `permissionsSummary` (the words `kampong lock` prints) and, from
  the project's lockfile, a `pin` state: `first-party`, `pinned`, `changed` (with what `widened`) or
  `unpinned`. A lockfile that cannot be read is listed as a problem and the components still show.
- `POST /api/components/pin { use, allowWiderPermissions }` pins one installed component through the same
  code as `kampong lock --update`. An update that widens what the component may do is refused unless the
  request says the author accepted it; the canvas only sends that after a checkbox that names the grant.
  Pinning is always preceded by a review step that shows the summary.
- **What is pinned is what was shown.** The canvas sends the digest it displayed (`expectedDigest`); if the
  files differ at pin time (an editor or a coding agent changed them meanwhile) the server answers 409 with
  the fresh catalog and pins nothing. The review panel is keyed on component and digest, so a consent given
  for one never carries to another. A built-in component is not pinnable.
- **Who may call.** These endpoints can pin a component and send credentials, so the dev server's `/api`
  now answers only loopback host names (plus the one `--host` was bound to, or any name when it was bound to
  every interface), and refuses a write whose `Origin` is not its own or that is marked cross-site. That
  closes the DNS-rebinding route from a web page to a local server, for the older `PUT /api/spec` and run
  endpoints as well.
- `POST /api/doctor { online, probe }` runs the doctor. Offline by default, as on the CLI. Reaching hosts
  and sending credentials are separate buttons with their own wording, since each leaves the machine.
  Checks name environment variables and never print values.
- Both are **local-server only** (`pinComponent` and `runDoctor` are optional on `ApiClient`); the hosted
  client omits them and the UI hides the controls, as for components generally (ADR-0020).
- State is never colour alone: each chip and each result carries words or a mark.

## Not covered

- The form is rebuilt when the set of installed components changes (including after a pin), which drops
  what was typed; a pin does not change the set, but a component added on disk while the form is open does.
- Two directories declaring the same `id@version` show as two entries; pinning one reports the conflict.

- A project's own `kind: module` probe, which still waits for a sandbox (ADR-0032).
- Browsing or installing components from a registry (KAN-1838).
- Hosted mode: workspaces have no `components/` folder or lockfile yet.
