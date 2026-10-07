# ADR-0037: Revocation, the shipped registry index, and keyless release signing

Date: 2026-10-07. Status: accepted. Card: KAN-1838. Implements the revocation and signing items of ADR-0026.

## Context

ADR-0026 asks for a revocation field in the registry index from day one, signed releases, and a disclosure
path. Pinning (ADR-0025) stops a component changing under a spec, but nothing could say "this version is
bad, stop running it", and a release had no verifiable origin.

## Decision

- **The index.** `registry-index` (JSON, `@kampong/spec`) lists `id`, `version`, content `digest`, `tier` (0
  first-party, 1 verified, 2 community) and an optional `revoked: { reason, at, advisory? }`. One ships with
  the engine (`packages/engine/components/registry-index.json`), generated from the first-party components
  by `npm run generate:registry-index`; a test fails when it is stale, and CI's release job regenerates and
  diffs it. Regenerating carries every recorded revocation over (also for files that changed or are gone),
  and refuses to run over a file it cannot parse, so it can never silently un-revoke.
- **Revocation is by bytes, or by version.** An entry with a digest revokes exactly those files. A revoked
  entry may omit the digest to revoke every build of that `id@version`, so a publisher re-spinning the
  files under the same name cannot slip past it. A different digest on a digest-bearing entry is a different
  thing, and the lockfile's digest check already refuses it.
- **Honoured everywhere a component resolves**, through one `RevocationRegistry` around the project's
  registry: a run, `kampong lock`, an export, `kampong doctor` (a failure naming the reason), and the canvas
  (a banner with the reason, date and advisory, and no pin button). The server's pin route refuses it too.
  The indexes are read on each resolve, so a new revocation applies to the next call.
- **Fail closed, and only take trust away.** A project may add `.kampong/registry-index.json`. Only its
  revoked entries are read, so an unverified file can revoke a component but never vouch for one or lift
  a revocation. An entry or field it does not understand elsewhere in the file does not stop the revocations
  beside it; an entry that claims a revocation but is invalid, a format version this kampong does not know,
  and a file that cannot be read all stop the call instead of being ignored. The advisory link must be https.
- **Not vendored.** The revocation code is outside what an export carries. An exported project cannot be
  revoked remotely (threat T9); the digests, `kampong.lock`, `sbom.json` and the startup check (ADR-0033)
  are the mitigation, and `SECURITY.md` says to watch advisories.
- **Release signing.** `.github/workflows/release.yml`, on a `v*` tag, runs the merge gate, builds a
  reproducible bundle (sorted, fixed mtime and owner; for inspection against the attestation, not an
  installable package), the registry index, a CycloneDX SBOM and `SHA256SUMS`, and attests each with `actions/attest-build-provenance`, which signs keylessly with Sigstore against the workflow's
  OIDC identity. There is no long-lived key. A tag must be on main, and a tag with a hyphen is published as a
  pre-release, never as Latest. The actions are pinned by tag, not by commit SHA. `gh attestation verify <file> --repo <owner>/<repo>` checks one.
- **Disclosure.** `SECURITY.md` (private advisory reporting and a response target), `.well-known/security.txt`
  (RFC 9116), and a test that fails when its `Expires` lapses, as a reminder to renew it.

## Not covered

- **The release workflow has not run.** It was written without a release to run it on; the commands it
  uses were run locally (the bundle and the SBOM) but the attestation step and the release creation were
  not. Try a pre-release tag before relying on it.
- **Fetching or verifying a remote index.** Nothing downloads an index, and no signature on an index is
  checked in the engine (that needs the `sigstore` verifier and a trust root). Until then, revocations
  arrive with a release or a local file.
- **The hosted server.** It does not run components yet; when it does it must resolve through the same
  `RevocationRegistry` before any tier above 0 can run there.
- **security.txt at a domain root.** The docs site is a GitHub Pages project site, which cannot serve
  `/.well-known/` at its host root, so the file lives in the repository; the contact is GitHub's private
  advisory form, not an email address.
- **Hash-to-import window.** A module is hashed (and checked for revocation) when it resolves and imported
  a moment later; a process that can write the component folder in between is not stopped (as before), and
  a run already in flight when a revocation lands keeps the module it has loaded.
- **security.txt is inert** unless private vulnerability reporting is enabled in the repository settings, which
  is a setting, not code.
- **Tier 1 and 2.** The index carries the tier, but only tier 0 exists; the vetting pipeline is still
  required before either opens (ADR-0026).
